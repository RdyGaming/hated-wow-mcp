import { readFileSync } from "node:fs";
import { join } from "node:path";

import { scoreName } from "../wowapi/search.js";
import type { LoadedUiSource, UiMixin, UiTemplate } from "./index.js";

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export function searchTemplates(
  source: LoadedUiSource,
  query: string,
  opts: { type?: string; limit?: number } = {},
): UiTemplate[] {
  const limit = opts.limit ?? 25;
  return source.raw.templates
    .filter((t) => !opts.type || t.type.toLowerCase() === opts.type.toLowerCase())
    .map((t) => ({ t, score: scoreName(t.name, query) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.t);
}

/**
 * Walks a template's `inherits` chain. Addon authors need this because a
 * template's useful attributes usually come from two or three levels up, and
 * the XML gives no hint that the chain exists.
 */
export function templateChain(
  source: LoadedUiSource,
  name: string,
  depth = 0,
): UiTemplate[] {
  if (depth > 12) return [];
  const t = source.byTemplate.get(name.toLowerCase());
  if (!t) return [];
  const parents = t.inherits.flatMap((p) => templateChain(source, p, depth + 1));
  return [t, ...parents];
}

export function renderTemplate(source: LoadedUiSource, t: UiTemplate): string {
  const lines = [
    `<${t.type} name="${t.name}" virtual="true">`,
    `    defined:  ${t.file}:${t.line}`,
  ];
  if (t.inherits.length) lines.push(`    inherits: ${t.inherits.join(", ")}`);
  if (t.mixin.length) lines.push(`    mixin:    ${t.mixin.join(", ")}`);

  const chain = templateChain(source, t.name).slice(1);
  if (chain.length) {
    lines.push(`    chain:    ${chain.map((c) => c.name).join(" -> ")}`);
  }

  const children = source.inheritedBy.get(t.name.toLowerCase()) ?? [];
  if (children.length) {
    lines.push(
      `    used by:  ${children.slice(0, 8).join(", ")}` +
        (children.length > 8 ? ` (+${children.length - 8} more)` : ""),
    );
  }

  // Mixins attached to a template carry its behaviour; listing their methods
  // is usually the answer to "what can I call on this thing".
  for (const mixinName of t.mixin) {
    const mixin = source.byMixin.get(mixinName.toLowerCase());
    if (mixin?.methods.length) {
      lines.push(
        `    ${mixin.name}: ${mixin.methods.slice(0, 12).join(", ")}` +
          (mixin.methods.length > 12 ? ` (+${mixin.methods.length - 12} more)` : ""),
      );
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Mixins
// ---------------------------------------------------------------------------

export function searchMixins(
  source: LoadedUiSource,
  query: string,
  limit = 25,
): UiMixin[] {
  const q = query.toLowerCase();
  return source.raw.mixins
    .map((m) => {
      // A query naming a method should find the mixin that defines it.
      const methodHit = m.methods.some((x) => x.toLowerCase() === q) ? 500 : 0;
      return { m, score: Math.max(scoreName(m.name, query), methodHit) };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.m);
}

export function renderMixin(m: UiMixin): string {
  const lines = [m.name, `    defined: ${m.file}:${m.line}`];
  if (m.composedFrom.length) {
    lines.push(`    composed from: ${m.composedFrom.join(", ")}`);
  }
  lines.push(`    methods (${m.methods.length}):`);
  for (const chunk of chunkList(m.methods, 6)) {
    lines.push(`        ${chunk.join(", ")}`);
  }
  return lines.join("\n");
}

function chunkList<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------
// Full-text search across the checkout
// ---------------------------------------------------------------------------

export interface GrepHit {
  file: string;
  line: number;
  text: string;
}

/**
 * Searches the synced Blizzard source for a pattern.
 *
 * Reading files on demand rather than holding 41 MB of source in memory keeps
 * the server's footprint small; the index already tells us which files are
 * worth opening, so the read set is bounded by the filters.
 */
export function grepUiSource(
  source: LoadedUiSource,
  pattern: string,
  opts: {
    ext?: "lua" | "xml" | "toc";
    pkg?: string;
    pathContains?: string;
    limit?: number;
    ignoreCase?: boolean;
    /** Lines of context on each side. */
    context?: number;
  } = {},
): { hits: GrepHit[]; filesSearched: number; truncated: boolean } {
  const limit = opts.limit ?? 60;
  const context = Math.min(opts.context ?? 0, 6);

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, opts.ignoreCase ? "i" : "");
  } catch (err) {
    throw new Error(`Invalid regular expression: ${(err as Error).message}`);
  }

  const candidates = source.raw.files.filter((f) => {
    if (opts.ext && f.ext !== opts.ext) return false;
    if (opts.pkg && f.pkg.toLowerCase() !== opts.pkg.toLowerCase()) return false;
    if (
      opts.pathContains &&
      !f.path.toLowerCase().includes(opts.pathContains.toLowerCase())
    ) {
      return false;
    }
    return true;
  });

  const hits: GrepHit[] = [];
  let filesSearched = 0;
  let truncated = false;

  for (const file of candidates) {
    if (hits.length >= limit) {
      truncated = true;
      break;
    }
    filesSearched++;

    let content: string;
    try {
      content = readFileSync(join(source.raw.checkoutDir, file.path), "utf8");
    } catch {
      continue; // File listed in the index but missing from disk; skip it.
    }
    if (!regex.test(content)) continue;

    const lines = content.split("\n");
    for (let i = 0; i < lines.length && hits.length < limit; i++) {
      if (!regex.test(lines[i]!)) continue;
      const from = Math.max(0, i - context);
      const to = Math.min(lines.length - 1, i + context);
      const text =
        context > 0
          ? lines
              .slice(from, to + 1)
              .map((l, k) => `${from + k + 1 === i + 1 ? ">" : " "} ${l}`)
              .join("\n")
          : lines[i]!.trim();
      hits.push({ file: file.path, line: i + 1, text });
    }
  }

  return { hits, filesSearched, truncated };
}
