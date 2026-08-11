import type { Flavor } from "../config.js";
import { loadIndex, type LoadedIndex } from "../wowapi/index.js";
import {
  COMBAT_LOCKED_METHODS,
  PATTERN_RULES,
  PROTECTED_FUNCTIONS,
  SECURE_TEMPLATES,
  TAINTED_IF_ASSIGNED,
  findRename,
  findSignatureChange,
} from "./rules.js";
import { LUA_BASE_GLOBALS, codeTokens, tokenize, type Token } from "./tokenizer.js";

export interface Diagnostic {
  rule: string;
  severity: "error" | "warning" | "info";
  line: number;
  column: number;
  message: string;
  /** Concrete replacement text where one exists. */
  suggestion?: string;
}

export interface AnalysisResult {
  file: string;
  flavor: string;
  diagnostics: Diagnostic[];
  stats: {
    lines: number;
    tokens: number;
    globalReads: number;
    globalWrites: number;
    apiCalls: number;
  };
}

// ---------------------------------------------------------------------------
// Scope tracking
// ---------------------------------------------------------------------------

/**
 * A deliberately approximate scope model.
 *
 * A real Lua parser would be more precise, but precision here mostly buys
 * false-negative reduction on shadowing, while costing robustness on files
 * that are mid-edit or use syntax we mis-model. The rule that matters is
 * "never report a name as global if it was declared local anywhere in an
 * enclosing block", and a stack of Sets gets that right.
 */
class ScopeStack {
  private frames: Set<string>[] = [new Set()];

  push(): void {
    this.frames.push(new Set());
  }

  pop(): void {
    if (this.frames.length > 1) this.frames.pop();
  }

  declare(name: string): void {
    this.frames[this.frames.length - 1]!.add(name);
  }

  /** Declares in the outermost frame — for file-level `local` at depth 0. */
  declareFileLocal(name: string): void {
    this.frames[0]!.add(name);
  }

  has(name: string): boolean {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      if (this.frames[i]!.has(name)) return true;
    }
    return false;
  }
}

/** Keywords that open a block whose locals should not escape. */
const BLOCK_OPENERS = new Set(["do", "then", "function", "repeat"]);
const BLOCK_CLOSERS = new Set(["end", "until"]);

// ---------------------------------------------------------------------------
// Name resolution
// ---------------------------------------------------------------------------

/**
 * Reads a dotted/colon call target starting at `start`, e.g. `C_Item.GetItemInfo`
 * or `frame:SetPoint`. Returns the joined name and the index just past it.
 */
function readQualifiedName(
  tokens: Token[],
  start: number,
): { name: string; parts: string[]; end: number; isMethod: boolean } {
  const parts = [tokens[start]!.value];
  let i = start + 1;
  let isMethod = false;

  while (
    tokens[i]?.type === "operator" &&
    (tokens[i]!.value === "." || tokens[i]!.value === ":") &&
    tokens[i + 1]?.type === "name"
  ) {
    if (tokens[i]!.value === ":") isMethod = true;
    parts.push(tokens[i + 1]!.value);
    i += 2;
  }

  return { name: parts.join("."), parts, end: i, isMethod };
}

/**
 * Given a bare global that no longer exists, finds namespaced functions of the
 * same name in this flavor. This is where most deprecation advice comes from:
 * it is derived from Blizzard's own index, so it stays correct across patches
 * without anyone maintaining a list.
 */
function findNamespacedReplacements(index: LoadedIndex, name: string): string[] {
  const candidates = index.byName.get(name.toLowerCase()) ?? [];
  return candidates.filter((f) => f.namespace).map((f) => f.signature);
}

/** Ranks replacement candidates so the likely one is offered first. */
function rankReplacements(candidates: string[]): string[] {
  // C_Item / C_Spell / C_Container / C_AddOns are the general-purpose
  // namespaces; collection- and vendor-specific ones are rarely what a caller
  // of the old bare global meant.
  const deprioritise = /^C_(AccountStore|TransmogCollection|MerchantFrame|Garrison|BarberShop|PingSecure|AchievementInfo|VoiceChat)\./;
  return [...candidates].sort((a, b) => {
    const pa = deprioritise.test(a) ? 1 : 0;
    const pb = deprioritise.test(b) ? 1 : 0;
    return pa - pb || a.length - b.length;
  });
}

// ---------------------------------------------------------------------------
// Main analysis
// ---------------------------------------------------------------------------

export interface AnalyzeOptions {
  file?: string;
  flavor: Flavor;
  /** Rule ids to suppress. */
  disable?: string[];
  /** Names the file legitimately defines as globals (its own addon table). */
  knownGlobals?: string[];
}

export function analyzeLua(source: string, opts: AnalyzeOptions): AnalysisResult {
  const index = loadIndex(opts.flavor);
  const flavorId = opts.flavor.id;
  const disabled = new Set(opts.disable ?? []);
  const diagnostics: Diagnostic[] = [];

  const add = (d: Diagnostic): void => {
    if (!disabled.has(d.rule)) diagnostics.push(d);
  };

  const { tokens: allTokens, errors: lexErrors } = tokenize(source);
  for (const e of lexErrors) {
    add({
      rule: "syntax",
      severity: "error",
      line: e.line,
      column: e.column,
      message: e.message,
    });
  }

  const tokens = codeTokens(allTokens);
  const scopes = new ScopeStack();
  const declaredGlobals = new Set<string>(opts.knownGlobals ?? []);

  // Addon files receive (addonName, privateTable) as varargs; the private table
  // is conventionally captured as a file-local and must not be flagged.
  scopes.declare("...");

  let globalReads = 0;
  let globalWrites = 0;
  let apiCalls = 0;
  let blockDepth = 0;

  // ---- pass 1: collect file-level global assignments -----------------------
  // Two passes so that a global defined at the bottom of a file is not
  // reported as undefined when read at the top (common with local function
  // forward references and addon namespace tables).
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.type !== "name") continue;
    if (i > 0 && tokens[i - 1]!.value === "local") continue;
    if (i > 0 && (tokens[i - 1]!.value === "." || tokens[i - 1]!.value === ":")) continue;

    const q = readQualifiedName(tokens, i);
    const next = tokens[q.end];
    if (next?.type === "operator" && next.value === "=" && tokens[q.end + 1]?.value !== "=") {
      if (q.parts.length === 1) declaredGlobals.add(q.name);
    }
    // `function Foo.Bar()` / `function Foo()` also defines a global.
    if (i > 0 && tokens[i - 1]!.value === "function" && tokens[i - 2]?.value !== "local") {
      declaredGlobals.add(q.parts[0]!);
    }
  }

  // ---- pass 2: walk ---------------------------------------------------------
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;

    if (t.type === "keyword") {
      if (BLOCK_OPENERS.has(t.value)) {
        blockDepth++;
        scopes.push();
      } else if (BLOCK_CLOSERS.has(t.value)) {
        blockDepth--;
        scopes.pop();
      } else if (t.value === "local") {
        // `local a, b, c` and `local function name`
        let j = i + 1;
        if (tokens[j]?.value === "function") {
          const nameTok = tokens[j + 1];
          if (nameTok?.type === "name") {
            if (blockDepth === 0) scopes.declareFileLocal(nameTok.value);
            else scopes.declare(nameTok.value);
          }
          continue;
        }
        while (tokens[j]?.type === "name") {
          if (blockDepth === 0) scopes.declareFileLocal(tokens[j]!.value);
          else scopes.declare(tokens[j]!.value);
          j++;
          if (tokens[j]?.value === ",") j++;
          else break;
        }
        continue;
      } else if (t.value === "for") {
        // `for i = ...` / `for k, v in ...` — loop variables are locals.
        let j = i + 1;
        scopes.push();
        while (tokens[j]?.type === "name") {
          scopes.declare(tokens[j]!.value);
          j++;
          if (tokens[j]?.value === ",") j++;
          else break;
        }
        continue;
      } else if (t.value === "function") {
        // Parameter list of an anonymous or method function.
        let j = i + 1;
        while (tokens[j] && tokens[j]!.value !== "(") j++;
        if (tokens[j]?.value === "(") {
          j++;
          // Colon-defined methods get an implicit self.
          scopes.declare("self");
          while (tokens[j] && tokens[j]!.value !== ")") {
            if (tokens[j]!.type === "name" || tokens[j]!.value === "...") {
              scopes.declare(tokens[j]!.value);
            }
            j++;
          }
        }
        continue;
      }
      continue;
    }

    if (t.type !== "name") continue;
    // Skip the field half of `a.b` — only the root matters for scoping.
    if (i > 0 && (tokens[i - 1]!.value === "." || tokens[i - 1]!.value === ":")) continue;
    // Skip table constructor keys: `{ name = value }`. Lua allows `,` and `;`
    // interchangeably as field separators and Blizzard's code uses both, so
    // missing `;` here would report every such key as a global assignment.
    if (
      tokens[i + 1]?.value === "=" &&
      tokens[i + 2]?.value !== "=" &&
      ["{", ",", ";"].includes(tokens[i - 1]?.value ?? "")
    ) {
      continue;
    }

    const q = readQualifiedName(tokens, i);
    const root = q.parts[0]!;
    const isLocal = scopes.has(root);
    const isAssignment =
      tokens[q.end]?.type === "operator" &&
      tokens[q.end]!.value === "=" &&
      tokens[q.end + 1]?.value !== "=";
    const isCall =
      tokens[q.end]?.value === "(" ||
      tokens[q.end]?.type === "string" ||
      tokens[q.end]?.value === "{";

    if (!isLocal) {
      if (isAssignment) globalWrites++;
      else globalReads++;
    }

    // -- taint: assigning to a Blizzard global --------------------------------
    if (isAssignment && !isLocal && TAINTED_IF_ASSIGNED.has(root) && q.parts.length === 1) {
      add({
        rule: "taint/global-assignment",
        severity: "error",
        line: t.line,
        column: t.column,
        message:
          `Assigning to the Blizzard global "${root}" taints it for the entire ` +
          "UI, including Blizzard's own protected code. Store your value in an " +
          "addon-scoped table instead.",
      });
    }

    // -- taint: replacing a Blizzard function outright ------------------------
    if (
      isAssignment &&
      !isLocal &&
      q.parts.length === 1 &&
      index.callableSet.has(root) &&
      !declaredGlobals.has(`__own_${root}`)
    ) {
      add({
        rule: "taint/overwrite-api",
        severity: "error",
        line: t.line,
        column: t.column,
        message:
          `"${root}" is a Blizzard API function; reassigning it taints every ` +
          "caller and breaks other addons.",
        suggestion: `hooksecurefunc("${root}", function(...) --[[ your code ]] end)`,
      });
    }

    if (!isCall) continue;
    apiCalls++;

    // -- protected function calls ---------------------------------------------
    if (PROTECTED_FUNCTIONS.has(q.name) && !isLocal) {
      add({
        rule: "taint/protected-call",
        severity: "error",
        line: t.line,
        column: t.column,
        message:
          `"${q.name}" is protected: the client blocks it when called from addon ` +
          "code, producing \"Interface action failed because of an AddOn\". Drive " +
          "it from a SecureActionButtonTemplate attribute or a secure handler snippet.",
      });
      continue;
    }

    // -- combat-locked frame methods ------------------------------------------
    if (q.isMethod && COMBAT_LOCKED_METHODS.has(q.parts[q.parts.length - 1]!)) {
      // Only interesting when the file also creates secure frames — otherwise
      // these methods are unrestricted and flagging them is pure noise.
      if (SECURE_TEMPLATES.some((tpl) => source.includes(tpl))) {
        add({
          rule: "taint/combat-locked",
          severity: "warning",
          line: t.line,
          column: t.column,
          message:
            `This file creates secure frames, and "${q.parts[q.parts.length - 1]}" ` +
            "is protected during combat. Guard it with InCombatLockdown() and " +
            "replay the change on PLAYER_REGEN_ENABLED.",
        });
      }
    }

    // -- explicit renames -----------------------------------------------------
    const rename = findRename(q.name, flavorId);
    if (rename && !isLocal) {
      add({
        rule: "api/renamed",
        severity: rename.severity ?? (rename.to === null ? "error" : "warning"),
        line: t.line,
        column: t.column,
        message: `${q.name} — ${rename.note}`,
        ...(rename.to ? { suggestion: rename.to } : {}),
      });
      continue;
    }

    // -- return-shape changes -------------------------------------------------
    const sig = findSignatureChange(q.name);
    if (sig) {
      add({
        rule: "api/signature-changed",
        severity: "info",
        line: t.line,
        column: t.column,
        message: `${q.name} — ${sig.note}`,
      });
    }

    // -- moved into a namespace (derived from the index) ----------------------
    if (!isLocal && q.parts.length === 1 && !LUA_BASE_GLOBALS.has(q.name)) {
      const callable = index.callableSet.has(q.name);
      if (!callable && !declaredGlobals.has(q.name)) {
        const replacements = rankReplacements(findNamespacedReplacements(index, q.name));
        if (replacements.length > 0) {
          // Reported as a warning, not an error: Blizzard often keeps the old
          // bare name working as an alias after moving a function, and neither
          // the generated docs nor the global list records that. The advice to
          // call the namespaced form is correct either way.
          add({
            rule: "api/moved-to-namespace",
            severity: "warning",
            line: t.line,
            column: t.column,
            message:
              `"${q.name}" has moved into a namespace in ${opts.flavor.label} and is ` +
              `no longer listed as a global. Call the namespaced form.` +
              (replacements.length > 1
                ? ` Candidates: ${replacements.join(", ")}.`
                : ""),
            suggestion: replacements[0]!,
          });
        } else if (/^[A-Z]/.test(q.name)) {
          // Unknown PascalCase call with no replacement: either a removed API
          // or a library function. Report as a warning rather than an error,
          // because embedded libraries legitimately define globals.
          add({
            rule: "api/unknown",
            severity: "warning",
            line: t.line,
            column: t.column,
            message:
              `"${q.name}" is not a known API in ${opts.flavor.label} and is not ` +
              "defined in this file. If it comes from an embedded library, add it " +
              "to knownGlobals; otherwise it may have been removed.",
          });
        }
      }
    }

    // -- namespaced call that does not exist in this flavor -------------------
    if (q.parts.length > 1 && !q.isMethod && index.namespaces.has(root)) {
      // `callableSet` is the union of the generated documentation and the flat
      // global list. The documentation alone is incomplete — several namespaces
      // (C_PetBattles among them) expose functions it never describes — so
      // checking only `bySignature` would reject working code.
      if (!index.callableSet.has(q.name) && !index.bySignature.has(q.name.toLowerCase())) {
        const sameName = findNamespacedReplacements(index, q.parts[q.parts.length - 1]!);
        add({
          rule: "api/unknown-namespaced",
          severity: "error",
          line: t.line,
          column: t.column,
          message:
            `"${q.name}" does not exist in ${opts.flavor.label}.` +
            (sameName.length ? ` Did you mean ${rankReplacements(sameName)[0]}?` : ""),
          ...(sameName.length ? { suggestion: rankReplacements(sameName)[0]! } : {}),
        });
      }
    }

    // -- event registration ----------------------------------------------------
    if (
      q.isMethod &&
      /^(Register|Unregister)Event$/.test(q.parts[q.parts.length - 1]!) &&
      tokens[q.end]?.value === "("
    ) {
      const arg = tokens[q.end + 1];
      if (arg?.type === "string") {
        const eventName = arg.value.slice(1, -1);
        if (/^[A-Z][A-Z0-9_]*$/.test(eventName) && !index.eventSet.has(eventName)) {
          add({
            rule: "event/unknown",
            severity: "warning",
            line: arg.line,
            column: arg.column,
            message:
              `"${eventName}" is not a known event in ${opts.flavor.label}. ` +
              "RegisterEvent throws for unknown events, which aborts the calling " +
              "function.",
          });
        }
      }
    }
  }

  // ---- line-based pattern rules --------------------------------------------
  const lines = source.split("\n");
  // Comment-only lines are excluded so that documentation about a pattern does
  // not trip the rule for that pattern.
  const commentLines = new Set(
    allTokens
      .filter((t) => t.type === "comment")
      .flatMap((t) => {
        const span = t.value.split("\n").length;
        return Array.from({ length: span }, (_, k) => t.line + k);
      }),
  );

  lines.forEach((text, idx) => {
    const lineNo = idx + 1;
    if (commentLines.has(lineNo) && /^\s*--/.test(text)) return;
    for (const rule of PATTERN_RULES) {
      if (rule.notForFlavors?.includes(flavorId)) continue;
      const m = rule.pattern.exec(text);
      if (m) {
        add({
          rule: rule.id,
          severity: rule.severity,
          line: lineNo,
          column: (m.index ?? 0) + 1,
          message: rule.message,
        });
      }
    }
  });

  diagnostics.sort((a, b) => a.line - b.line || a.column - b.column);

  return {
    file: opts.file ?? "<inline>",
    flavor: opts.flavor.label,
    diagnostics,
    stats: {
      lines: lines.length,
      tokens: tokens.length,
      globalReads,
      globalWrites,
      apiCalls,
    },
  };
}

export function formatDiagnostics(result: AnalysisResult): string {
  if (result.diagnostics.length === 0) {
    return `${result.file}: no issues found (${result.flavor}, ${result.stats.lines} lines, ${result.stats.apiCalls} calls checked).`;
  }

  const counts = { error: 0, warning: 0, info: 0 };
  const lines = [`${result.file}  [${result.flavor}]`, ""];

  for (const d of result.diagnostics) {
    counts[d.severity]++;
    lines.push(`  ${d.line}:${d.column}  ${d.severity.padEnd(7)} ${d.rule}`);
    lines.push(`      ${d.message}`);
    if (d.suggestion) lines.push(`      -> ${d.suggestion}`);
  }

  lines.push(
    "",
    `${counts.error} error(s), ${counts.warning} warning(s), ${counts.info} note(s) ` +
      `across ${result.stats.lines} lines.`,
  );
  return lines.join("\n");
}
