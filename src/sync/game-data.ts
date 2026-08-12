#!/usr/bin/env tsx
/**
 * Builds the game-data bridge: the FileDataID <-> file path mapping every
 * addon needs in order to reference art, plus the texture atlas tables.
 *
 * Sources:
 *   wowdev/wow-listfile (GitHub release) .. community listfile, ~2.2M entries.
 *                                          This is the canonical FileDataID
 *                                          mapping the community maintains.
 *   wago.tools ........................... UiTextureAtlas / UiTextureAtlasMember
 *                                          DB2 exports, for GetAtlasInfo names.
 *
 * By default only `interface/**` is indexed (~172k entries) — that is what
 * addon code can actually reference. Pass --full to also emit the complete
 * listfile for model and map work.
 *
 * Usage:
 *   npm run sync-game-data
 *   npm run sync-game-data -- --full
 *   npm run sync-game-data -- --build 12.0.7.60000
 */

import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(HERE, "..", "data");
const CACHE_DIR = resolve(DATA_DIR, ".cache");

const LISTFILE_URL =
  "https://github.com/wowdev/wow-listfile/releases/latest/download/community-listfile.csv";
const WAGO_BASE = "https://wago.tools";

// ---------------------------------------------------------------------------

async function download(url: string, dest: string): Promise<void> {
  process.stderr.write(`fetching ${url}\n`);
  const res = await fetch(url, {
    headers: { "user-agent": "wow-mcp-server/sync" },
    redirect: "follow",
  });
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest));
}

// ---------------------------------------------------------------------------
// Listfile
// ---------------------------------------------------------------------------

export interface FileEntry {
  /** FileDataID — what SetTexture/SetModel accept directly. */
  id: number;
  /** Lowercased game path, e.g. `interface/icons/spell_fire_fireball.blp`. */
  path: string;
}

/**
 * Groups paths by their top-level directory so lookups can be scoped without
 * scanning the whole list, and so the on-disk index stays compact.
 */
interface FilesIndex {
  generatedAt: string;
  source: string;
  counts: Record<string, number>;
  /** Every `interface/**` entry, sorted by path. */
  interface: FileEntry[];
  /** Distinct top-level directories in the full listfile, with entry counts. */
  roots: Record<string, number>;
  /** Present only when built with --full. */
  full?: FileEntry[];
}

async function buildFilesIndex(full: boolean): Promise<FilesIndex> {
  await mkdir(CACHE_DIR, { recursive: true });
  const csvPath = resolve(CACHE_DIR, "community-listfile.csv");

  await download(LISTFILE_URL, csvPath);

  process.stderr.write("parsing listfile…\n");
  const text = await readFile(csvPath, "utf8");

  const ifaceEntries: FileEntry[] = [];
  const allEntries: FileEntry[] = [];
  const roots: Record<string, number> = {};

  for (const line of text.split("\n")) {
    if (!line) continue;
    const sep = line.indexOf(";");
    if (sep === -1) continue;
    const id = Number(line.slice(0, sep));
    if (!Number.isFinite(id)) continue;
    const path = line.slice(sep + 1).trim().toLowerCase();
    if (!path) continue;

    const root = path.slice(0, path.indexOf("/") === -1 ? undefined : path.indexOf("/"));
    roots[root] = (roots[root] ?? 0) + 1;

    const entry = { id, path };
    if (path.startsWith("interface/")) ifaceEntries.push(entry);
    if (full) allEntries.push(entry);
  }

  ifaceEntries.sort((a, b) => a.path.localeCompare(b.path));

  const index: FilesIndex = {
    generatedAt: new Date().toISOString(),
    source: LISTFILE_URL,
    counts: {
      total: Object.values(roots).reduce((a, b) => a + b, 0),
      interface: ifaceEntries.length,
      icons: ifaceEntries.filter((e) => e.path.startsWith("interface/icons/")).length,
    },
    interface: ifaceEntries,
    roots,
  };

  if (full) {
    allEntries.sort((a, b) => a.id - b.id);
    index.full = allEntries;
  }

  return index;
}

// ---------------------------------------------------------------------------
// Texture atlases
// ---------------------------------------------------------------------------

export interface AtlasEntry {
  /** Atlas element name — what you pass to SetAtlas / GetAtlasInfo. */
  name: string;
  /** FileDataID of the sheet this element lives on. */
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

/** Minimal CSV reader: handles quoted fields, which wago exports do use. */
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }

  const header = rows.shift();
  if (!header) return [];
  return rows
    .filter((r) => r.length >= header.length)
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

async function fetchDb2(table: string, build?: string): Promise<Record<string, string>[]> {
  const url = `${WAGO_BASE}/db2/${table}/csv${build ? `?build=${encodeURIComponent(build)}` : ""}`;
  process.stderr.write(`fetching ${url}\n`);
  const res = await fetch(url, {
    headers: { "user-agent": "wow-mcp-server/sync", accept: "text/csv" },
    redirect: "follow",
  });
  if (!res.ok) {
    // wago.tools runs bot protection and blocks many datacentre/VPN ranges.
    // The bare status code sends people hunting for a bug that isn't here, so
    // say what to actually do about it — and that nothing else is affected.
    throw new Error(
      [
        `HTTP ${res.status} fetching ${table} from wago.tools.`,
        "",
        "wago.tools uses bot protection. Open https://wago.tools/ in a browser,",
        "let the page finish loading, then re-run this command.",
        "",
        "Still failing? You are probably on a blocked datacentre, cloud or VPN",
        "IP — try a normal desktop connection with any VPN turned off.",
        "",
        "This step only powers wow_atlas_search. The file index above is already",
        "written, and the other 18 tools work without it.",
      ].join("\n"),
    );
  }
  return parseCsv(await res.text());
}

async function buildAtlasIndex(build?: string): Promise<{
  generatedAt: string;
  build: string;
  counts: Record<string, number>;
  atlases: AtlasEntry[];
}> {
  // UiTextureAtlas describes each sheet; UiTextureAtlasMember describes each
  // named element on it. Both are needed to turn a name into usable coords.
  const [sheets, members] = await Promise.all([
    fetchDb2("UiTextureAtlas", build),
    fetchDb2("UiTextureAtlasMember", build),
  ]);

  const sheetById = new Map<string, Record<string, string>>();
  for (const s of sheets) {
    const id = s.ID ?? s.id ?? "";
    if (id) sheetById.set(id, s);
  }

  const num = (v: string | undefined): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  const atlases: AtlasEntry[] = [];
  for (const m of members) {
    const name = m.CommittedName ?? m.Name ?? "";
    if (!name) continue;
    const sheet = sheetById.get(m.UiTextureAtlasID ?? "");
    const sheetWidth = num(sheet?.AtlasWidth) || 1;
    const sheetHeight = num(sheet?.AtlasHeight) || 1;

    const left = num(m.CommittedLeft);
    const right = num(m.CommittedRight);
    const top = num(m.CommittedTop);
    const bottom = num(m.CommittedBottom);

    atlases.push({
      name,
      fileDataID: num(sheet?.FileDataID),
      width: Math.round((right - left) * sheetWidth),
      height: Math.round((bottom - top) * sheetHeight),
      left,
      right,
      top,
      bottom,
      tilesHorizontally: num(m.CommittedFlags) % 2 === 1,
      tilesVertically: Math.floor(num(m.CommittedFlags) / 2) % 2 === 1,
    });
  }

  atlases.sort((a, b) => a.name.localeCompare(b.name));

  return {
    generatedAt: new Date().toISOString(),
    build: build ?? "latest",
    counts: { atlases: atlases.length, sheets: sheetById.size },
    atlases,
  };
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const full = args.includes("--full");
  const buildIdx = args.indexOf("--build");
  const build = buildIdx !== -1 ? args[buildIdx + 1] : undefined;
  const skipAtlas = args.includes("--no-atlas");

  await mkdir(DATA_DIR, { recursive: true });

  // Files first: it is the part that always works, and the atlas fetch depends
  // on a third-party host that may be unreachable from some networks.
  const files = await buildFilesIndex(full);
  await writeFile(resolve(DATA_DIR, "files-index.json"), JSON.stringify(files), "utf8");
  process.stderr.write(
    `wrote data/files-index.json (${JSON.stringify(files.counts)})\n`,
  );

  if (skipAtlas) {
    process.stderr.write("skipping atlas sync (--no-atlas)\n");
    return;
  }

  try {
    const atlas = await buildAtlasIndex(build);
    await writeFile(resolve(DATA_DIR, "atlas-index.json"), JSON.stringify(atlas), "utf8");
    process.stderr.write(
      `wrote data/atlas-index.json (${JSON.stringify(atlas.counts)})\n`,
    );
  } catch (err) {
    process.stderr.write(
      `\nAtlas sync failed: ${(err as Error).message}\n` +
        "The file index above is complete and usable on its own; only the\n" +
        "wow_atlas_* tools need this step. wago.tools blocks some networks and\n" +
        "cloud egress ranges — re-run this script from a normal desktop\n" +
        "connection to populate the atlas index.\n",
    );
    process.exitCode = 0;
  }
}

main().catch((err) => {
  process.stderr.write(`sync-game-data failed: ${(err as Error).stack}\n`);
  process.exit(1);
});
