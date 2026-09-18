#!/usr/bin/env node
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
 * The atlas is built per client, since atlases differ between them. With no
 * client named, that is the default client plus every one found installed.
 *
 * Usage:
 *   npm run sync-game-data
 *   npm run sync-game-data -- forever          # one client: mainline, classic, vanilla, forever
 *   npm run sync-game-data -- --full
 *   npm run sync-game-data -- forever --build 1.60.1.69913
 *   npm run sync-game-data -- --force   # ignore the cache and rebuild
 */

import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { resolve } from "node:path";

import { DATA_PATHS, defaultSyncIndexes } from "../config.js";
import { cacheRoot } from "../paths.js";
import { WAGO_PRODUCT, pickLatestBuild, type WagoBuild } from "./wago.js";

// Both indexes are heavy and rebuilt from upstream, so they belong in the
// writable cache root rather than inside the package. See src/paths.ts.
const DATA_DIR = cacheRoot();
const CACHE_DIR = resolve(DATA_DIR, ".cache");

const LISTFILE_URL =
  "https://github.com/wowdev/wow-listfile/releases/latest/download/community-listfile.csv";
const WAGO_BASE = "https://wago.tools";

// ---------------------------------------------------------------------------

/** Validators from the last successful download, stored beside the file. */
interface CacheMeta {
  url: string;
  etag?: string;
  lastModified?: string;
}

export interface DownloadResult {
  /** Upstream answered 304 — `dest` is the previous copy, still current. */
  notModified: boolean;
  etag?: string;
}

async function readMeta(metaPath: string): Promise<CacheMeta | null> {
  try {
    return JSON.parse(await readFile(metaPath, "utf8")) as CacheMeta;
  } catch {
    return null;
  }
}

/**
 * Downloads `url` to `dest`, but only when upstream says it changed.
 *
 * The listfile is ~149MB and is republished far less often than people re-sync,
 * so every sync used to spend minutes re-fetching bytes it already had. We keep
 * the ETag / Last-Modified from the previous fetch in a sidecar and revalidate
 * with it; an unchanged listfile costs one round trip instead of 149MB.
 *
 * The body streams to a temp file and is renamed into place only once complete,
 * so an interrupted download cannot leave a truncated file behind that a later
 * run would then trust.
 */
async function download(url: string, dest: string, force = false): Promise<DownloadResult> {
  const metaPath = `${dest}.meta.json`;
  const headers: Record<string, string> = { "user-agent": "wow-mcp-server/sync" };

  const prior = force ? null : await readMeta(metaPath);
  if (prior?.url === url && existsSync(dest)) {
    if (prior.etag) headers["if-none-match"] = prior.etag;
    if (prior.lastModified) headers["if-modified-since"] = prior.lastModified;
  }

  process.stderr.write(`fetching ${url}\n`);
  const res = await fetch(url, { headers, redirect: "follow" });

  if (res.status === 304) {
    process.stderr.write("  unchanged upstream — reusing the cached copy\n");
    return { notModified: true, ...(prior?.etag ? { etag: prior.etag } : {}) };
  }
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }

  const tmp = `${dest}.partial`;
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tmp));
  await rename(tmp, dest);

  const etag = res.headers.get("etag") ?? undefined;
  const lastModified = res.headers.get("last-modified") ?? undefined;
  await writeFile(
    metaPath,
    JSON.stringify({ url, etag, lastModified } satisfies CacheMeta),
    "utf8",
  );

  return { notModified: false, ...(etag ? { etag } : {}) };
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
  /** ETag of the listfile this index was built from, for revalidation. */
  sourceEtag?: string;
  counts: Record<string, number>;
  /** Every `interface/**` entry, sorted by path. */
  interface: FileEntry[];
  /** Distinct top-level directories in the full listfile, with entry counts. */
  roots: Record<string, number>;
  /** Present only when built with --full. */
  full?: FileEntry[];
}

/**
 * The index on disk, but only if it is still current: built from the listfile
 * we just revalidated, and in the mode being asked for. A --full run must
 * rebuild an interface-only index even when the listfile itself is unchanged.
 */
async function readIndexIfCurrent(
  etag: string | undefined,
  full: boolean,
): Promise<FilesIndex | null> {
  if (!etag) return null;
  try {
    const existing = JSON.parse(
      await readFile(resolve(DATA_DIR, "files-index.json"), "utf8"),
    ) as FilesIndex;
    if (existing.sourceEtag !== etag) return null;
    if (full && !existing.full) return null;
    return existing;
  } catch {
    return null;
  }
}

/**
 * Returns null when the existing index is already current — the listfile did
 * not change and the index on disk was built from that same listfile in the
 * same mode. Re-parsing 149MB to produce identical output helps no one.
 */
async function buildFilesIndex(
  full: boolean,
  force: boolean,
): Promise<FilesIndex | null> {
  await mkdir(CACHE_DIR, { recursive: true });
  const csvPath = resolve(CACHE_DIR, "community-listfile.csv");

  const fetched = await download(LISTFILE_URL, csvPath, force);

  if (fetched.notModified && !force) {
    const existing = await readIndexIfCurrent(fetched.etag, full);
    if (existing) return null;
  }

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
    ...(fetched.etag ? { sourceEtag: fetched.etag } : {}),
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
  const explicitBuild = buildIdx !== -1 ? args[buildIdx + 1] : undefined;
  const skipAtlas = args.includes("--no-atlas");
  const force = args.includes("--force");

  // Positional arguments name the clients to build atlases for. The value after
  // --build is not one of them.
  const requested = args.filter(
    (a, i) => !a.startsWith("-") && !(buildIdx !== -1 && i === buildIdx + 1),
  );
  const unknown = requested.filter((k) => !(k in WAGO_PRODUCT));
  if (unknown.length > 0) {
    process.stderr.write(
      `Unknown client "${unknown[0]}". Expected one of: ${Object.keys(WAGO_PRODUCT).join(", ")}\n`,
    );
    process.exit(1);
  }
  if (explicitBuild && requested.length > 1) {
    process.stderr.write("--build names one build, so it needs exactly one client after it.\n");
    process.exit(1);
  }

  await mkdir(DATA_DIR, { recursive: true });

  // Files first: it is the part that always works, and the atlas fetch depends
  // on a third-party host that may be unreachable from some networks.
  const files = await buildFilesIndex(full, force);
  if (files === null) {
    process.stderr.write("file index already current — skipped (--force to rebuild)\n");
  } else {
    const filesPath = resolve(DATA_DIR, "files-index.json");
    await writeFile(filesPath, JSON.stringify(files), "utf8");
    process.stderr.write(`wrote ${filesPath} (${JSON.stringify(files.counts)})\n`);
  }

  if (skipAtlas) {
    process.stderr.write("skipping atlas sync (--no-atlas)\n");
    return;
  }

  // With no client named, follow the same rule as the UI source sync: the
  // default client plus every one found installed.
  let keys = requested;
  if (keys.length === 0) {
    const chosen = defaultSyncIndexes();
    keys = chosen.keys.filter((k) => k in WAGO_PRODUCT);
    process.stderr.write(`atlas for: ${keys.join(", ")}\n`);
  }

  for (const key of keys) {
    try {
      // Non-retail clients must have an exact build. "latest" means retail on
      // wago, so falling back to it would write retail atlases under this
      // client's name, and a search would confidently return the wrong art.
      const build = explicitBuild ?? (await resolveBuild(key));
      if (!build && key !== "mainline") {
        throw new Error(
          `could not find the latest ${WAGO_PRODUCT[key]} build on wago.tools, ` +
            "and guessing would risk indexing the wrong client's atlases. Pass --build.",
        );
      }

      const atlas = await buildAtlasIndex(build);
      const atlasPath = DATA_PATHS.atlasFor(key);
      await writeFile(
        atlasPath,
        JSON.stringify({ ...atlas, flavor: key, product: WAGO_PRODUCT[key] }),
        "utf8",
      );
      process.stderr.write(
        `wrote ${atlasPath} [${key}, build ${atlas.build}] (${JSON.stringify(atlas.counts)})\n`,
      );
    } catch (err) {
      process.stderr.write(
        `\nAtlas sync failed for ${key}: ${(err as Error).message}\n` +
          "The file index above is complete and usable on its own; only the\n" +
          "wow_atlas_* tools need this step. wago.tools blocks some networks and\n" +
          "cloud egress ranges, so re-run this from a normal desktop connection.\n",
      );
    }
  }
}

let buildList: Record<string, WagoBuild[]> | null = null;

/** The newest real build for a client, from wago's build list (fetched once). */
async function resolveBuild(key: string): Promise<string | undefined> {
  try {
    if (!buildList) {
      const res = await fetch(`${WAGO_BASE}/api/builds`, {
        headers: { "user-agent": "wow-mcp-server/sync" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      buildList = (await res.json()) as Record<string, WagoBuild[]>;
    }
    return pickLatestBuild(buildList, WAGO_PRODUCT[key]!);
  } catch (err) {
    process.stderr.write(`could not read wago.tools' build list: ${(err as Error).message}\n`);
    return undefined;
  }
}

main().catch((err) => {
  process.stderr.write(`sync-game-data failed: ${(err as Error).stack}\n`);
  process.exit(1);
});
