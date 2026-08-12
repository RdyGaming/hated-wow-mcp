/**
 * CVar lookup, from two sources that answer different halves of the question.
 *
 * The API index carries the authoritative *registry* — every CVar name the
 * client knows, ~1,700 of them. It says nothing about what any of them do.
 *
 * The UI source index carries *evidence*: which CVars Blizzard's own interface
 * reads or writes, how it reads them, where, and — for the few hundred exposed
 * in the options UI — what that UI calls them.
 *
 * Neither is sufficient alone. A name in the registry with no usage is real but
 * undocumented; usage without a registry entry usually means a CVar the client
 * registers dynamically. Reporting which of the two a result came from is the
 * honest answer, and it is the thing that tells an addon author how much to
 * trust it.
 */

import { scoreName } from "../wowapi/search.js";
import type { ApiCVar } from "../wowapi/types.js";
import type { UiCVar } from "./index.js";

export interface CVarHit extends UiCVar {
  /** True when the client's own CVar registry lists this name. */
  known: boolean;
  /** The registry entry — default, category, scope, protection, description. */
  registry?: ApiCVar;
}

/** A registry name we have no usage evidence for. */
function bare(name: string, known: boolean): CVarHit {
  return { name, refs: 0, files: [], accessors: [], known };
}

export function searchCVars(
  query: string,
  registry: Set<string>,
  registryByName: Map<string, ApiCVar>,
  used: UiCVar[] | undefined,
  limit: number,
): CVarHit[] {
  const byName = new Map<string, CVarHit>();

  for (const cvar of used ?? []) {
    const key = cvar.name.toLowerCase();
    const entry = registryByName.get(key);
    byName.set(key, {
      ...cvar,
      known: registry.has(cvar.name),
      ...(entry ? { registry: entry } : {}),
    });
  }
  for (const name of registry) {
    const key = name.toLowerCase();
    if (byName.has(key)) continue;
    const entry = registryByName.get(key);
    byName.set(key, { ...bare(name, true), ...(entry ? { registry: entry } : {}) });
  }

  const scored: Array<{ hit: CVarHit; score: number }> = [];
  for (const hit of byName.values()) {
    const score = scoreName(hit.name, query);
    if (score <= 0) continue;
    // Among equally-good name matches, the ones Blizzard actually uses are the
    // ones a reader can learn something from, so let usage break the tie.
    scored.push({ hit, score: score + Math.min(hit.refs, 50) });
  }

  return scored
    .sort((a, b) => b.score - a.score || a.hit.name.localeCompare(b.hit.name))
    .slice(0, limit)
    .map((s) => s.hit);
}

/** Best guess at the value shape, from how Blizzard reads it. */
function inferredType(hit: CVarHit): string | undefined {
  if (hit.varType) return hit.varType.toLowerCase();
  if (hit.accessors.some((a) => a.includes("Bitfield"))) return "bitfield";
  if (hit.accessors.some((a) => a.includes("Bool"))) return "boolean";
  if (hit.accessors.some((a) => a.includes("Number"))) return "number";
  return undefined;
}

/** Where the value is stored, which decides whether a change follows the player. */
function scope(entry: ApiCVar): string {
  if (entry.account && entry.character) return "account and character";
  if (entry.account) return "per WoW account";
  if (entry.character) return "per character";
  return "global to the install";
}

export function renderCVar(hit: CVarHit): string {
  const lines = [hit.name];
  const entry = hit.registry;

  // Blizzard's own description first — it is the thing that answers "what is
  // this?", which everything below only circumstantially hints at.
  if (entry?.help) lines.push(`  ${entry.help}`);

  if (entry) {
    lines.push(`  default:   ${entry.default === "" ? '""  (empty)' : entry.default}`);
    if (entry.category) lines.push(`  category:  ${entry.category}`);
    lines.push(`  stored:    ${scope(entry)}`);
    if (entry.secure) {
      // The one field that changes what an addon may legally do.
      lines.push(
        "  PROTECTED: an addon cannot set this — SetCVar will fail or taint. " +
          "Offer it as a /console instruction instead.",
      );
    }
  }

  const type = inferredType(hit);
  if (type) {
    lines.push(`  type:      ${type}${hit.varType ? "" : "  (inferred from usage)"}`);
  }

  if (!hit.known) {
    lines.push("  registry:  not listed — registered at runtime, or removed");
  }

  if (hit.refs === 0) {
    lines.push("  usage:     Blizzard's UI never touches it — no usage to learn from");
    return lines.join("\n");
  }

  lines.push(
    `  usage:     ${hit.refs} reference${hit.refs === 1 ? "" : "s"} via ${hit.accessors.join(", ")}`,
  );

  if (hit.labelKey) {
    // The text is localized in the client, so the key is all we have. Saying
    // how to turn it into text in game is more useful than omitting it.
    lines.push(`  options:   shown in Blizzard's settings as _G["${hit.labelKey}"]`);
    if (hit.tooltipKey) lines.push(`             tooltip _G["${hit.tooltipKey}"]`);
  }

  lines.push("  seen in:");
  for (const file of hit.files) lines.push(`    ${file}`);

  return lines.join("\n");
}
