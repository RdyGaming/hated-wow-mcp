#!/usr/bin/env node
/**
 * Rebuilds data/api-index.json from Blizzard's own generated interface
 * documentation, mirrored on GitHub.
 *
 * Sources (all public, fetched over plain HTTPS — no auth, no GitHub API):
 *   Gethe/wow-ui-source .......... Blizzard_APIDocumentationGenerated/*.lua
 *                                  (the in-game /api docs: systems, functions,
 *                                  arguments, returns, events, enums, mixins)
 *   Ketho/BlizzardInterfaceResources
 *                                  Resources/GlobalAPI.lua  (flat global list)
 *                                  Resources/Events.lua     (event + payload)
 *                                  Resources/CVars.lua
 *
 * Usage:
 *   npm run sync-data                 # all flavors
 *   npm run sync-data -- mainline     # one flavor
 */

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { BUNDLED_DIR, isCheckout } from "../paths.js";

// Unlike the other two syncs, this one rebuilds data that ships inside the
// package, so it writes to the package directory rather than the cache root.
const DATA_DIR = BUNDLED_DIR;

const RAW = "https://raw.githubusercontent.com";
const UI_SRC = `${RAW}/Gethe/wow-ui-source`;
const RESOURCES = `${RAW}/Ketho/BlizzardInterfaceResources`;
const DOC_DIR = "Interface/AddOns/Blizzard_APIDocumentationGenerated";

/** Branch layout of the two upstream mirrors, per game flavor. */
const FLAVOR_BRANCHES: Record<string, { uiSource: string; resources: string }> = {
  // Retail. `live` tracks whatever build is on live realms.
  mainline: { uiSource: "live", resources: "master" },
  // Classic progression client (whichever expansion is current there).
  classic: { uiSource: "classic", resources: "classic" },
  // Classic Era / Anniversary realms.
  vanilla: { uiSource: "classic_era", resources: "classic_era" },
};

const CONCURRENCY = 12;

// ---------------------------------------------------------------------------
// Minimal Lua table-literal parser
// ---------------------------------------------------------------------------

type LuaValue = string | number | boolean | LuaValue[] | { [k: string]: LuaValue };

/**
 * Parses the single `local X = { ... }` table literal out of a generated
 * documentation file. These files are machine-written by Blizzard's exporter,
 * so the grammar they use is a small, predictable subset of Lua: string,
 * number and boolean scalars, nested tables, and both array-style and
 * `key = value` entries. Anything outside that subset is a hard error rather
 * than a silent skip, so upstream format changes surface loudly.
 */
function parseLuaTable(source: string): Record<string, LuaValue> {
  const start = source.indexOf("{");
  if (start === -1) throw new Error("no table literal found");

  let i = start;

  const fail = (msg: string): never => {
    const line = source.slice(0, i).split("\n").length;
    throw new Error(`${msg} at line ${line}`);
  };

  const skipTrivia = (): void => {
    for (;;) {
      while (i < source.length && /\s/.test(source[i]!)) i++;
      if (source.startsWith("--[[", i)) {
        const end = source.indexOf("]]", i);
        i = end === -1 ? source.length : end + 2;
        continue;
      }
      if (source.startsWith("--", i)) {
        const end = source.indexOf("\n", i);
        i = end === -1 ? source.length : end + 1;
        continue;
      }
      return;
    }
  };

  const parseString = (): string => {
    const quote = source[i]!;
    i++;
    let out = "";
    while (i < source.length && source[i] !== quote) {
      if (source[i] === "\\") {
        const esc = source[i + 1]!;
        out +=
          esc === "n" ? "\n" : esc === "t" ? "\t" : esc === "r" ? "\r" : esc;
        i += 2;
        continue;
      }
      out += source[i];
      i++;
    }
    i++; // closing quote
    return out;
  };

  const parsePrimary = (): LuaValue => {
    skipTrivia();
    const ch = source[i];
    if (ch === undefined) return fail("unexpected end of input");
    if (ch === '"' || ch === "'") return parseString();
    if (ch === "{") return parseTable();

    const rest = source.slice(i);
    const num = /^-?(?:0x[0-9a-fA-F]+|\d+\.?\d*(?:[eE][-+]?\d+)?|\.\d+)/.exec(rest);
    if (num) {
      i += num[0].length;
      return Number(num[0]);
    }
    const word = /^[A-Za-z_][\w.]*/.exec(rest);
    if (word) {
      i += word[0].length;
      if (word[0] === "true") return true;
      if (word[0] === "false") return false;
      if (word[0] === "nil") return "";
      return word[0]; // bare identifier, e.g. a constant reference
    }
    return fail(`unparseable value starting with ${JSON.stringify(ch)}`);
  };

  const parseValue = (): LuaValue => {
    const exprStart = (skipTrivia(), i);
    let value = parsePrimary();

    // Constants tables express some values as arithmetic over other constants
    // (`Enum.A.X + Enum.A.Y`, `Constants.C.LAST - Constants.C.FIRST + 1`).
    // We cannot evaluate those without the enum tables, so keep the expression
    // verbatim: it is still the most useful thing to show a caller.
    let sawOperator = false;
    for (;;) {
      const save = i;
      skipTrivia();
      if (!/^[-+*/%]/.test(source.slice(i)) || /^[-+]{2}/.test(source.slice(i))) {
        i = save;
        break;
      }
      sawOperator = true;
      i++; // operator
      parsePrimary();
    }

    return sawOperator ? source.slice(exprStart, i).replace(/\s+/g, " ").trim() : value;
  };

  const parseTable = (): LuaValue => {
    if (source[i] !== "{") return fail("expected '{'");
    i++;
    const map: Record<string, LuaValue> = {};
    const arr: LuaValue[] = [];

    for (;;) {
      skipTrivia();
      if (source[i] === "}") {
        i++;
        break;
      }
      if (source[i] === undefined) return fail("unterminated table");

      // Look ahead for `key =` (but not `==`).
      const keyMatch = /^([A-Za-z_]\w*)\s*=(?!=)/.exec(source.slice(i));
      const bracketKey = /^\[\s*"([^"]*)"\s*\]\s*=(?!=)/.exec(source.slice(i));

      if (keyMatch) {
        i += keyMatch[0].length;
        map[keyMatch[1]!] = parseValue();
      } else if (bracketKey) {
        i += bracketKey[0].length;
        map[bracketKey[1]!] = parseValue();
      } else {
        arr.push(parseValue());
      }

      skipTrivia();
      if (source[i] === "," || source[i] === ";") i++;
    }

    return arr.length > 0 && Object.keys(map).length === 0 ? arr : map;
  };

  const result = parseValue();
  if (typeof result !== "object" || Array.isArray(result)) {
    throw new Error("top-level value is not a keyed table");
  }
  return result as Record<string, LuaValue>;
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

async function fetchText(url: string, attempt = 1): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "wow-mcp-server/sync" },
      signal: AbortSignal.timeout(60_000),
    });
    if (res.status === 404) throw new Error(`404 ${url}`);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return await res.text();
  } catch (err) {
    if (attempt >= 3) throw err;
    await new Promise((r) => setTimeout(r, 500 * attempt));
    return fetchText(url, attempt + 1);
  }
}

/** Runs `worker` over `items` with a bounded number of in-flight requests. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!, index);
    }
  });
  await Promise.all(runners);
  return results;
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

interface ApiParam {
  name: string;
  type: string;
  nilable: boolean;
  default?: string | number | boolean;
  mixin?: string;
  innerType?: string;
  /** Present on Enumeration fields: the numeric value of this member. */
  enumValue?: number;
  documentation?: string[];
}

interface ApiFunction {
  name: string;
  system: string;
  namespace?: string;
  /** Fully-qualified call name, e.g. `C_Item.CanBeRefunded`. */
  signature: string;
  arguments: ApiParam[];
  returns: ApiParam[];
  documentation?: string[];
  events?: string[];
  secretArguments?: string;
  secretReturns?: string;
}

interface ApiEvent {
  name: string;
  system: string;
  literalName: string;
  payload: ApiParam[];
  documentation?: string[];
}

interface ApiTable {
  name: string;
  system: string;
  kind: string;
  fields?: ApiParam[];
  values?: { name: string; value: number | string; type?: string }[];
  documentation?: string[];
}

const asArray = (v: LuaValue | undefined): Record<string, LuaValue>[] =>
  Array.isArray(v) ? (v as Record<string, LuaValue>[]) : [];

const asStrings = (v: LuaValue | undefined): string[] | undefined =>
  Array.isArray(v) ? (v as string[]).map(String) : undefined;

function toParam(raw: Record<string, LuaValue>): ApiParam {
  const p: ApiParam = {
    name: String(raw.Name ?? ""),
    type: String(raw.Type ?? "unknown"),
    nilable: raw.Nilable === true,
  };
  if (raw.Default !== undefined) p.default = raw.Default as string | number | boolean;
  if (raw.Mixin !== undefined) p.mixin = String(raw.Mixin);
  if (raw.InnerType !== undefined) p.innerType = String(raw.InnerType);
  if (typeof raw.EnumValue === "number") p.enumValue = raw.EnumValue;
  const doc = asStrings(raw.Documentation);
  if (doc) p.documentation = doc;
  return p;
}

function normaliseSystem(
  doc: Record<string, LuaValue>,
  file: string,
): {
  functions: ApiFunction[];
  events: ApiEvent[];
  tables: ApiTable[];
} {
  // A handful of generated files declare only shared Tables and carry no
  // system Name; fall back to the filename so nothing is labelled "Unknown".
  const system = String(
    doc.Name ?? file.replace(/(API)?Documentation\.lua$/i, "") ?? "Unknown",
  );
  const namespace = doc.Namespace ? String(doc.Namespace) : undefined;

  const functions: ApiFunction[] = asArray(doc.Functions).map((fn) => {
    const name = String(fn.Name ?? "");
    const out: ApiFunction = {
      name,
      system,
      signature: namespace ? `${namespace}.${name}` : name,
      arguments: asArray(fn.Arguments).map(toParam),
      returns: asArray(fn.Returns).map(toParam),
    };
    if (namespace) out.namespace = namespace;
    const doclines = asStrings(fn.Documentation);
    if (doclines) out.documentation = doclines;
    const events = asStrings(fn.Events);
    if (events) out.events = events;
    if (fn.SecretArguments) out.secretArguments = String(fn.SecretArguments);
    if (fn.SecretReturns) out.secretReturns = String(fn.SecretReturns);
    return out;
  });

  const events: ApiEvent[] = asArray(doc.Events).map((ev) => {
    const out: ApiEvent = {
      name: String(ev.Name ?? ""),
      system,
      literalName: String(ev.LiteralName ?? ev.Name ?? ""),
      payload: asArray(ev.Payload).map(toParam),
    };
    const doclines = asStrings(ev.Documentation);
    if (doclines) out.documentation = doclines;
    return out;
  });

  const tables: ApiTable[] = asArray(doc.Tables).map((tbl) => {
    const out: ApiTable = {
      name: String(tbl.Name ?? ""),
      system,
      kind: String(tbl.Type ?? "Structure"),
    };
    const fields = asArray(tbl.Fields);
    if (fields.length) out.fields = fields.map(toParam);
    // `Type = "Enumeration"` tables carry EnumValue; `Type = "Constants"`
    // tables carry Value, which may be a string or a constant expression.
    const values = asArray(tbl.Values);
    if (values.length) {
      out.values = values.map((v) => {
        const raw = v.EnumValue ?? v.Value;
        const entry: { name: string; value: number | string; type?: string } = {
          name: String(v.Name ?? ""),
          value: typeof raw === "number" ? raw : String(raw ?? ""),
        };
        if (v.Type !== undefined) entry.type = String(v.Type);
        return entry;
      });
    }
    const doclines = asStrings(tbl.Documentation);
    if (doclines) out.documentation = doclines;
    return out;
  });

  return { functions, events, tables };
}

// ---------------------------------------------------------------------------
// Per-flavor build
// ---------------------------------------------------------------------------

async function buildFlavor(flavor: string): Promise<Record<string, unknown>> {
  const branches = FLAVOR_BRANCHES[flavor];
  if (!branches) throw new Error(`unknown flavor: ${flavor}`);

  const base = `${UI_SRC}/${branches.uiSource}/${DOC_DIR}`;
  process.stderr.write(`\n[${flavor}] reading documentation manifest…\n`);

  const toc = await fetchText(`${base}/Blizzard_APIDocumentationGenerated.toc`);
  const files = toc
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.toLowerCase().endsWith(".lua") && !l.startsWith("#"));

  process.stderr.write(`[${flavor}] ${files.length} documentation files\n`);

  const functions: ApiFunction[] = [];
  const events: ApiEvent[] = [];
  const tables: ApiTable[] = [];
  const failures: string[] = [];
  let done = 0;

  await mapLimit(files, CONCURRENCY, async (file) => {
    try {
      const src = await fetchText(`${base}/${file}`);
      const doc = parseLuaTable(src);
      const n = normaliseSystem(doc, file);
      functions.push(...n.functions);
      events.push(...n.events);
      tables.push(...n.tables);
    } catch (err) {
      failures.push(`${file}: ${(err as Error).message}`);
    }
    done++;
    if (done % 50 === 0 || done === files.length) {
      process.stderr.write(`[${flavor}]   ${done}/${files.length}\n`);
    }
  });

  // Flat list of legacy (non-namespaced) globals — these predate the generated
  // docs and mostly have no machine-readable signature, but knowing they exist
  // and are callable in this flavor is what stops false "unknown API" lints.
  let globals: string[] = [];
  try {
    const src = await fetchText(
      `${RESOURCES}/${branches.resources}/Resources/GlobalAPI.lua`,
    );
    globals = [...src.matchAll(/^\s*"([^"]+)",?\s*$/gm)].map((m) => m[1]!);
  } catch (err) {
    failures.push(`GlobalAPI.lua: ${(err as Error).message}`);
  }

  let eventNames: string[] = [];
  try {
    const src = await fetchText(
      `${RESOURCES}/${branches.resources}/Resources/Events.lua`,
    );
    eventNames = [...src.matchAll(/^\s*\[?"?([A-Z][A-Z0-9_]+)"?\]?\s*=/gm)].map(
      (m) => m[1]!,
    );
    if (eventNames.length === 0) {
      eventNames = [...src.matchAll(/^\s*"([A-Z][A-Z0-9_]+)",?\s*$/gm)].map((m) => m[1]!);
    }
  } catch (err) {
    failures.push(`Events.lua: ${(err as Error).message}`);
  }

  let cvars: string[] = [];
  try {
    const src = await fetchText(
      `${RESOURCES}/${branches.resources}/Resources/CVars.lua`,
    );
    cvars = [...src.matchAll(/^\s*\[?"([a-zA-Z][\w]*)"\]?\s*=/gm)].map((m) => m[1]!);
  } catch {
    /* CVars are a nice-to-have; a missing file is not fatal. */
  }

  for (const f of failures) process.stderr.write(`[${flavor}] WARN ${f}\n`);

  // Union of every documented event name and every name in the flat list.
  const allEvents = [...new Set([...events.map((e) => e.literalName), ...eventNames])]
    .filter(Boolean)
    .sort();

  return {
    flavor,
    generatedAt: new Date().toISOString(),
    upstream: {
      uiSource: `Gethe/wow-ui-source@${branches.uiSource}`,
      resources: `Ketho/BlizzardInterfaceResources@${branches.resources}`,
    },
    counts: {
      functions: functions.length,
      events: allEvents.length,
      tables: tables.length,
      globals: globals.length,
      cvars: cvars.length,
    },
    functions: functions.sort((a, b) => a.signature.localeCompare(b.signature)),
    events: events.sort((a, b) => a.literalName.localeCompare(b.literalName)),
    tables: tables.sort((a, b) => a.name.localeCompare(b.name)),
    globals: globals.sort(),
    eventNames: allEvents,
    cvars: cvars.sort(),
    failures,
  };
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (!isCheckout()) {
    process.stderr.write(
      [
        "The API index ships inside the package, so there is nothing to sync here.",
        "",
        "Upgrade to get a newer index:  npm install hated-wow-mcp@latest",
        "",
        "This sync exists to regenerate the bundled data from a git checkout.",
        "",
      ].join("\n"),
    );
    process.exit(1);
  }

  const requested = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const flavors = requested.length > 0 ? requested : Object.keys(FLAVOR_BRANCHES);

  await mkdir(DATA_DIR, { recursive: true });

  const summary: Record<string, unknown> = {};
  for (const flavor of flavors) {
    const built = await buildFlavor(flavor);
    const target = resolve(DATA_DIR, `api-${flavor}.json`);
    await writeFile(target, JSON.stringify(built), "utf8");
    summary[flavor] = built.counts;
    process.stderr.write(
      `[${flavor}] wrote ${target} (${JSON.stringify(built.counts)})\n`,
    );
  }

  // Refresh the UI XML schema alongside the API data — it changes with the
  // client, and a stale copy would reject valid new frame attributes.
  try {
    const xsd = await fetchText(
      `${UI_SRC}/live/Interface/AddOns/Blizzard_SharedXML/UI.xsd`,
    );
    await writeFile(resolve(DATA_DIR, "ui.xsd"), xsd, "utf8");
    process.stderr.write(`[schema] wrote data/ui.xsd (${xsd.length} bytes)\n`);
  } catch (err) {
    process.stderr.write(`[schema] WARN ${(err as Error).message}\n`);
  }

  await writeFile(
    resolve(DATA_DIR, "manifest.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), flavors: summary }, null, 2),
    "utf8",
  );
  process.stderr.write("\nDone.\n");
}

main().catch((err) => {
  process.stderr.write(`sync failed: ${(err as Error).stack}\n`);
  process.exit(1);
});
