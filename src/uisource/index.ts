import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import { DATA_PATHS, dataMissingMessage, type Flavor } from "../config.js";

export interface UiFile {
  path: string;
  pkg: string;
  ext: "lua" | "xml" | "toc";
  lines: number;
  bytes: number;
}

export interface UiTemplate {
  name: string;
  type: string;
  inherits: string[];
  mixin: string[];
  file: string;
  line: number;
}

export interface UiMixin {
  name: string;
  composedFrom: string[];
  methods: string[];
  file: string;
  line: number;
}

export interface UiSourceIndex {
  flavor: string;
  branch: string;
  commit: string;
  generatedAt: string;
  checkoutDir: string;
  counts: Record<string, number>;
  packages: string[];
  files: UiFile[];
  templates: UiTemplate[];
  mixins: UiMixin[];
  globalStrings: Record<string, string>;
}

export interface LoadedUiSource {
  raw: UiSourceIndex;
  byTemplate: Map<string, UiTemplate>;
  byMixin: Map<string, UiMixin>;
  byPath: Map<string, UiFile>;
  /** Template name -> templates that inherit from it. */
  inheritedBy: Map<string, string[]>;
}

let cache: Record<string, LoadedUiSource> | null = null;

export const UI_SOURCE_MISSING = dataMissingMessage(
  "Blizzard UI source",
  "ui-source",
);

function loadAll(): Record<string, UiSourceIndex> {
  if (!existsSync(DATA_PATHS.uiSource)) throw new Error(UI_SOURCE_MISSING);
  const all = JSON.parse(readFileSync(DATA_PATHS.uiSource, "utf8")) as Record<
    string,
    UiSourceIndex
  >;

  // `checkoutDir` is an absolute path baked in at sync time. It goes stale if
  // the index outlives the machine that built it — a moved cache directory, or
  // an index restored from elsewhere. The checkout always sits beside the index
  // it describes, so fall back to that rather than failing every file read.
  for (const raw of Object.values(all)) {
    if (!raw.checkoutDir || !existsSync(raw.checkoutDir)) {
      raw.checkoutDir = join(DATA_PATHS.uiCheckout, raw.branch);
    }
  }

  return all;
}

export function loadUiSource(flavor: Flavor): LoadedUiSource {
  if (!cache) {
    const all = loadAll();
    cache = {};
    for (const [key, raw] of Object.entries(all)) {
      const byTemplate = new Map<string, UiTemplate>();
      const inheritedBy = new Map<string, string[]>();
      for (const t of raw.templates) {
        byTemplate.set(t.name.toLowerCase(), t);
        for (const parent of t.inherits) {
          const list = inheritedBy.get(parent.toLowerCase()) ?? [];
          list.push(t.name);
          inheritedBy.set(parent.toLowerCase(), list);
        }
      }
      cache[key] = {
        raw,
        byTemplate,
        byMixin: new Map(raw.mixins.map((m) => [m.name.toLowerCase(), m])),
        byPath: new Map(raw.files.map((f) => [f.path.toLowerCase(), f])),
        inheritedBy,
      };
    }
  }

  // Only the three indexed flavors exist; the Classic progression flavors
  // share the `classic` index the same way the API index does.
  const key = flavor.apiIndex === "vanilla" ? "vanilla" : flavor.apiIndex;
  const loaded = cache[key] ?? cache.mainline;
  if (!loaded) {
    throw new Error(
      `${UI_SOURCE_MISSING}\n\n(No index found for "${key}" — run the sync with that flavor.)`,
    );
  }
  return loaded;
}

/**
 * Reads a file out of the synced checkout. Paths are resolved against the
 * checkout root and verified to stay inside it, so a crafted `..` path in a
 * tool argument cannot read arbitrary files from the host.
 */
export function readUiFile(
  source: LoadedUiSource,
  relPath: string,
): { path: string; content: string } {
  const root = resolve(source.raw.checkoutDir);
  const target = resolve(join(root, relPath));

  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`Refusing to read outside the UI source checkout: ${relPath}`);
  }
  if (!existsSync(target)) {
    throw new Error(
      `"${relPath}" is not in the synced UI source. Use wow_ui_find_file to locate it.`,
    );
  }

  return { path: relPath, content: readFileSync(target, "utf8") };
}
