import type { LoadedIndex } from "./index.js";
import type { ApiEvent, ApiFunction, ApiParam, ApiTable } from "./types.js";

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Ranks a candidate name against a query. Higher is better; 0 means no match.
 *
 * The ordering matters more than the absolute numbers: an exact hit must beat
 * a prefix hit, which must beat a substring hit, which must beat a
 * subsequence ("camel-hump") hit. Without that last tier, `GIIBID` would not
 * find `GetItemInfoByID`, which is the kind of query people actually type.
 */
export function scoreName(candidate: string, query: string): number {
  const c = candidate.toLowerCase();
  const q = query.toLowerCase();
  if (!q) return 0;

  if (c === q) return 1000;
  if (c.endsWith(`.${q}`)) return 900; // matched the bare name of C_Foo.Bar
  if (c.startsWith(q)) return 800 - Math.min(candidate.length, 200);

  const idx = c.indexOf(q);
  if (idx !== -1) return 600 - idx - Math.min(candidate.length, 100) / 10;

  // Subsequence: every query character appears in order.
  let ci = 0;
  for (const ch of q) {
    ci = c.indexOf(ch, ci);
    if (ci === -1) return 0;
    ci++;
  }
  return 200 - Math.min(candidate.length, 150) / 10;
}

function scoreDocs(docs: string[] | undefined, query: string): number {
  if (!docs?.length) return 0;
  return docs.join(" ").toLowerCase().includes(query.toLowerCase()) ? 150 : 0;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface SearchHit<T> {
  item: T;
  score: number;
}

export function searchFunctions(
  index: LoadedIndex,
  query: string,
  opts: { namespace?: string; system?: string; limit?: number } = {},
): SearchHit<ApiFunction>[] {
  const limit = opts.limit ?? 25;
  const hits: SearchHit<ApiFunction>[] = [];

  for (const fn of index.raw.functions) {
    if (opts.namespace && fn.namespace?.toLowerCase() !== opts.namespace.toLowerCase()) {
      continue;
    }
    if (opts.system && fn.system.toLowerCase() !== opts.system.toLowerCase()) continue;

    const score = Math.max(
      scoreName(fn.signature, query),
      scoreName(fn.name, query),
      scoreDocs(fn.documentation, query),
    );
    if (score > 0) hits.push({ item: fn, score });
  }

  // Legacy globals have no documented signature but are still real answers;
  // surface them as zero-argument stubs rather than pretending they do not
  // exist, and rank them just below documented hits of equal name quality.
  for (const g of index.raw.globals) {
    if (opts.namespace || opts.system) break;
    if (index.byName.has(g.toLowerCase())) continue;
    const score = scoreName(g, query);
    if (score > 0) {
      hits.push({
        item: {
          name: g,
          system: "Legacy (undocumented global)",
          signature: g,
          arguments: [],
          returns: [],
          documentation: [
            "This global exists in this client but Blizzard publishes no generated",
            "signature for it. Check warcraft.wiki.gg for community documentation.",
          ],
        },
        score: score - 50,
      });
    }
  }

  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

export function searchEvents(
  index: LoadedIndex,
  query: string,
  limit = 25,
): SearchHit<ApiEvent>[] {
  const hits: SearchHit<ApiEvent>[] = [];
  const seen = new Set<string>();

  for (const ev of index.raw.events) {
    const score = Math.max(
      scoreName(ev.literalName, query),
      scoreName(ev.name, query),
      scoreDocs(ev.documentation, query),
    );
    if (score > 0) {
      hits.push({ item: ev, score });
      seen.add(ev.literalName);
    }
  }

  for (const name of index.raw.eventNames) {
    if (seen.has(name)) continue;
    const score = scoreName(name, query);
    if (score > 0) {
      hits.push({
        item: { name, system: "Undocumented", literalName: name, payload: [] },
        score: score - 50,
      });
    }
  }

  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

export function searchTables(
  index: LoadedIndex,
  query: string,
  opts: { kind?: string; limit?: number } = {},
): SearchHit<ApiTable>[] {
  const limit = opts.limit ?? 25;
  const hits: SearchHit<ApiTable>[] = [];

  for (const t of index.raw.tables) {
    if (opts.kind && t.kind.toLowerCase() !== opts.kind.toLowerCase()) continue;
    let score = Math.max(scoreName(t.name, query), scoreDocs(t.documentation, query));
    // A query naming a member ("Epic" for Enum.ItemQuality) should find the
    // enum that contains it, at a lower rank than a name match.
    if (score === 0) {
      const memberHit =
        t.fields?.some((f) => f.name.toLowerCase() === query.toLowerCase()) ||
        t.values?.some((v) => v.name.toLowerCase() === query.toLowerCase());
      if (memberHit) score = 120;
    }
    if (score > 0) hits.push({ item: t, score });
  }

  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderParam(p: ApiParam): string {
  const parts: string[] = [`${p.name}: ${p.type}`];
  if (p.innerType) parts.push(`<${p.innerType}>`);
  if (p.nilable) parts.push("?");
  const suffix: string[] = [];
  if (p.default !== undefined && p.default !== "") suffix.push(`default=${p.default}`);
  if (p.mixin) suffix.push(`mixin=${p.mixin}`);
  if (p.enumValue !== undefined) suffix.push(`= ${p.enumValue}`);
  const tail = suffix.length ? `  (${suffix.join(", ")})` : "";
  const doc = p.documentation?.length ? ` -- ${p.documentation.join(" ")}` : "";
  return `${parts.join("")}${tail}${doc}`;
}

export function renderFunction(fn: ApiFunction): string {
  const args = fn.arguments.map((a) => a.name + (a.nilable ? "?" : "")).join(", ");
  const rets = fn.returns.map((r) => r.name).join(", ");
  const head = rets
    ? `${rets} = ${fn.signature}(${args})`
    : `${fn.signature}(${args})`;

  const lines: string[] = [head, `  system: ${fn.system}`];

  if (fn.documentation?.length) {
    lines.push(`  ${fn.documentation.join("\n  ")}`);
  }
  if (fn.arguments.length) {
    lines.push("  arguments:");
    for (const a of fn.arguments) lines.push(`    - ${renderParam(a)}`);
  }
  if (fn.returns.length) {
    lines.push("  returns:");
    for (const r of fn.returns) lines.push(`    - ${renderParam(r)}`);
  }
  if (fn.events?.length) {
    lines.push(`  fires: ${fn.events.join(", ")}`);
  }
  // "Secret" values are the Midnight-era protection on combat-sensitive data:
  // worth surfacing, because it changes whether you can read the value at all.
  if (fn.secretArguments) lines.push(`  secretArguments: ${fn.secretArguments}`);
  if (fn.secretReturns) lines.push(`  secretReturns: ${fn.secretReturns}`);

  return lines.join("\n");
}

export function renderEvent(ev: ApiEvent): string {
  const lines: string[] = [ev.literalName, `  system: ${ev.system}`];
  if (ev.documentation?.length) lines.push(`  ${ev.documentation.join("\n  ")}`);
  if (ev.payload.length) {
    lines.push("  payload:");
    ev.payload.forEach((p, i) => lines.push(`    ${i + 1}. ${renderParam(p)}`));
  } else {
    lines.push("  payload: (none documented)");
  }
  return lines.join("\n");
}

export function renderTable(t: ApiTable): string {
  const lines: string[] = [`${t.name}  [${t.kind}]`, `  system: ${t.system}`];
  if (t.documentation?.length) lines.push(`  ${t.documentation.join("\n  ")}`);
  if (t.fields?.length) {
    lines.push(t.kind === "Enumeration" ? "  members:" : "  fields:");
    for (const f of t.fields) lines.push(`    - ${renderParam(f)}`);
  }
  if (t.values?.length) {
    lines.push("  values:");
    for (const v of t.values) lines.push(`    - ${v.name} = ${v.value}`);
  }
  return lines.join("\n");
}
