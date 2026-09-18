import { existsSync, readFileSync } from "node:fs";

import {
  DATA_PATHS,
  RUN_IT_YOURSELF,
  dataMissingMessage,
  resolveFlavor,
  syncCommand,
  type Flavor,
} from "../config.js";
import { cacheRoot } from "../paths.js";
import { scoreName } from "../wowapi/search.js";

export interface FileEntry {
  /** FileDataID — accepted directly by SetTexture, SetModel and friends. */
  id: number;
  /** Lowercased game path, e.g. `interface/icons/spell_fire_fireball.blp`. */
  path: string;
}

export interface FilesIndex {
  generatedAt: string;
  source: string;
  counts: Record<string, number>;
  interface: FileEntry[];
  roots: Record<string, number>;
  full?: FileEntry[];
}

export interface LoadedFiles {
  raw: FilesIndex;
  byId: Map<number, FileEntry>;
  byPath: Map<string, FileEntry>;
  /** True when the index was built with --full (models, maps, sounds, …). */
  hasFull: boolean;
}

let cache: LoadedFiles | null = null;

export const FILES_MISSING = dataMissingMessage("game file", "game-data");

export function loadFiles(): LoadedFiles {
  if (cache) return cache;
  if (!existsSync(DATA_PATHS.files)) throw new Error(FILES_MISSING);

  const raw = JSON.parse(readFileSync(DATA_PATHS.files, "utf8")) as FilesIndex;
  const entries = raw.full ?? raw.interface;

  const byId = new Map<number, FileEntry>();
  const byPath = new Map<string, FileEntry>();
  for (const e of entries) {
    byId.set(e.id, e);
    byPath.set(e.path, e);
  }
  // The interface subset is always indexed by path even in --full mode, so a
  // texture lookup never depends on which mode the sync ran in.
  for (const e of raw.interface) {
    byId.set(e.id, e);
    byPath.set(e.path, e);
  }

  cache = { raw, byId, byPath, hasFull: Boolean(raw.full) };
  return cache;
}

// ---------------------------------------------------------------------------

export interface FileSearchOptions {
  /** Restrict to a path prefix, e.g. `interface/icons/`. */
  under?: string;
  /** Restrict by extension, without the dot. */
  ext?: string;
  limit?: number;
  /** Search the full listfile rather than just `interface/**`. */
  includeNonInterface?: boolean;
}

export function searchFiles(
  files: LoadedFiles,
  query: string,
  opts: FileSearchOptions = {},
): FileEntry[] {
  const limit = opts.limit ?? 40;
  const pool =
    opts.includeNonInterface && files.raw.full ? files.raw.full : files.raw.interface;

  const under = opts.under?.toLowerCase().replace(/\\/g, "/");
  const ext = opts.ext?.toLowerCase().replace(/^\./, "");
  const q = query.toLowerCase().replace(/\\/g, "/");

  // A numeric query is a FileDataID lookup, not a name search.
  if (/^\d+$/.test(q)) {
    const hit = files.byId.get(Number(q));
    return hit ? [hit] : [];
  }

  const scored: { entry: FileEntry; score: number }[] = [];
  for (const entry of pool) {
    if (under && !entry.path.startsWith(under)) continue;
    if (ext && !entry.path.endsWith(`.${ext}`)) continue;

    // Score against the basename first: users search for `fireball`, not for
    // the directory it happens to live in.
    const base = entry.path.slice(entry.path.lastIndexOf("/") + 1);
    const score = Math.max(scoreName(base, q), scoreName(entry.path, q) - 100);
    if (score > 0) scored.push({ entry, score });
  }

  return scored
    .sort((a, b) => b.score - a.score || a.entry.path.localeCompare(b.entry.path))
    .slice(0, limit)
    .map((s) => s.entry);
}

/**
 * Renders a file entry with the forms an addon can actually use.
 *
 * Both are given because they are not interchangeable: a FileDataID works
 * everywhere and survives Blizzard moving the file, while the path string is
 * what you need for texture coordinates in XML and for older APIs.
 */
export function renderFileEntry(entry: FileEntry): string {
  // The client wants paths without the extension and with backslashes.
  const texturePath = entry.path.replace(/\.(blp|tga|png)$/i, "").replace(/\//g, "\\");
  const lines = [
    `${entry.id}  ${entry.path}`,
    `    FileDataID:   ${entry.id}`,
  ];
  if (/\.(blp|tga|png)$/i.test(entry.path)) {
    lines.push(
      `    texture path: "${texturePath}"`,
      `    Lua:          tex:SetTexture(${entry.id})`,
    );
  } else if (/\.(m2|mdx)$/i.test(entry.path)) {
    lines.push(`    Lua:          model:SetModel(${entry.id})`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Atlases
// ---------------------------------------------------------------------------

export interface AtlasEntry {
  name: string;
  fileDataID: number;
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  tilesHorizontally: boolean;
  tilesVertically: boolean;
}

export interface AtlasIndex {
  generatedAt: string;
  build: string;
  /** Index key this was built for. Absent in a retail index from before there was one per client. */
  flavor?: string;
  /** The wago product the build came from, e.g. wow_classic_beta. */
  product?: string;
  counts: Record<string, number>;
  atlases: AtlasEntry[];
}

const atlasCache = new Map<string, { raw: AtlasIndex; byName: Map<string, AtlasEntry> }>();

function atlasMissing(flavor: Flavor): string {
  return [
    `The texture atlas index for ${flavor.label} has not been built yet.`,
    "",
    `Run \`${syncCommand("game-data", flavor.apiIndex)}\` to fetch and index it.`,
    "That sync downloads from public mirrors and needs outbound network access.",
    RUN_IT_YOURSELF,
    "",
    `It will be written to ${cacheRoot()}`,
    "",
    "Atlas data comes from wago.tools, which blocks some cloud and datacentre",
    "networks. If the sync reports HTTP 403, run it from a normal desktop",
    "connection; the rest of the game-data sync works either way.",
  ].join("\n");
}

/**
 * The atlas index for one client. Atlases differ between clients, so each has
 * its own file. With no flavor given, the default flavor's is used, matching
 * what every other tool does.
 */
export function loadAtlas(flavor?: Flavor): { raw: AtlasIndex; byName: Map<string, AtlasEntry> } {
  const resolved = flavor ?? resolveFlavor();
  const key = resolved.apiIndex;

  const cached = atlasCache.get(key);
  if (cached) return cached;

  const path = DATA_PATHS.atlasFor(key);
  if (!existsSync(path)) throw new Error(atlasMissing(resolved));

  const raw = JSON.parse(readFileSync(path, "utf8")) as AtlasIndex;
  const loaded = {
    raw,
    byName: new Map(raw.atlases.map((a) => [a.name.toLowerCase(), a])),
  };
  atlasCache.set(key, loaded);
  return loaded;
}

export function searchAtlas(query: string, limit = 40, flavor?: Flavor): AtlasEntry[] {
  const { raw } = loadAtlas(flavor);
  return raw.atlases
    .map((a) => ({ a, score: scoreName(a.name, query) }))
    .filter((s) => s.score > 0)
    .sort((x, y) => y.score - x.score)
    .slice(0, limit)
    .map((s) => s.a);
}

export function renderAtlasEntry(entry: AtlasEntry, files?: LoadedFiles): string {
  const sheet = files?.byId.get(entry.fileDataID);
  const lines = [
    entry.name,
    `    size:   ${entry.width} x ${entry.height}`,
    `    sheet:  ${entry.fileDataID}${sheet ? `  (${sheet.path})` : ""}`,
    `    coords: left=${entry.left.toFixed(6)} right=${entry.right.toFixed(6)} ` +
      `top=${entry.top.toFixed(6)} bottom=${entry.bottom.toFixed(6)}`,
    `    Lua:    tex:SetAtlas("${entry.name}", true)`,
  ];
  if (entry.tilesHorizontally || entry.tilesVertically) {
    lines.push(
      `    tiling: ${entry.tilesHorizontally ? "horizontal " : ""}${entry.tilesVertically ? "vertical" : ""}`.trimEnd(),
    );
  }
  return lines.join("\n");
}

/**
 * Build timestamps for the two game-data indexes, or undefined when a set is
 * not synced. Neither throws: these annotate answers, and a missing annotation
 * must not turn a working answer into an error.
 */
export function loadFilesGeneratedAt(): string | undefined {
  try {
    return loadFiles().raw.generatedAt;
  } catch {
    return undefined;
  }
}

export function loadAtlasGeneratedAt(flavor?: Flavor): string | undefined {
  try {
    return loadAtlas(flavor).raw.generatedAt;
  } catch {
    return undefined;
  }
}
