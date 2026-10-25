/**
 * Bridge to the model exporter ported from wow.export (see THIRD_PARTY.md).
 *
 * The ported code is CommonJS under ./lib and is copied into dist by the build
 * (scripts/copy-lib.mjs). It reads the local install's CASC storage directly;
 * nothing is downloaded at run time.
 */

import { createReadStream, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { findInstallations, type Installation } from "../config.js";
import { cacheRoot } from "../paths.js";

export interface ExportResult {
  path: string;
  type: "m2" | "wmo";
  name: string;
  files: { type: string; fileDataID: number; file: string }[];
}

export interface CreatureHit {
  id: number;
  name: string;
  displayID: number;
  fileDataID?: number;
  model?: string;
  /** Built from a player race model (most named NPCs). */
  humanoid: boolean;
}

interface Driver {
  open(opts: { gameRoot: string; listfileCsv: string; product?: string }): Promise<unknown>;
  exportModel(opts: {
    fileDataID: number;
    outDir: string;
    format?: string;
    animations?: boolean;
    splitGroups?: boolean;
  }): Promise<ExportResult>;
  exportTexture(spec: string | number, outDir: string): Promise<string>;
  searchCreatures(opts: { query: string; limit?: number }): Promise<CreatureHit[]>;
  exportCreature(opts: {
    creatureId?: number;
    displayId?: number;
    outDir: string;
    format?: string;
    animations?: boolean;
  }): Promise<ExportResult & { displayID: number; fileDataID: number; textures: number[] }>;
}

const PRODUCT_BY_API: Record<string, string> = {
  mainline: "wow",
  forever: "wow_classic_beta",
  classic: "wow_classic",
  vanilla: "wow_classic_era",
};

export const dataDir = (): string => join(cacheRoot(), "wowexport");
export const listfileCsv = (): string => join(cacheRoot(), ".cache", "community-listfile.csv");

export const SETUP_MESSAGE =
  "The model exporter needs two synced data sets: the FileDataID listfile and the DBD " +
  "table definitions. Ask the user to run `npx -y hated-wow-mcp sync game-data` and " +
  "`npx -y hated-wow-mcp sync model-data` (from a clone: `npm run sync-game-data` and " +
  "`npm run sync-model-data`). This server makes no network calls itself.";

export function setupProblem(): string | null {
  if (!existsSync(listfileCsv())) return SETUP_MESSAGE;
  if (!existsSync(join(dataDir(), "dbd", "ModelFileData.dbd"))) return SETUP_MESSAGE;
  return null;
}

let driver: Driver | null = null;
let openKey = "";

function load(): Driver {
  if (driver) return driver;
  // constants.js reads this at require time.
  process.env.WOWEXPORT_DATA = dataDir();
  const require = createRequire(import.meta.url);
  driver = require("./lib/driver.js") as Driver;
  return driver;
}

export function pickInstall(flavorId?: string): Installation {
  const installs = findInstallations();
  if (installs.length === 0) {
    throw new Error("No World of Warcraft install found. Set WOW_INSTALL_PATH.");
  }
  if (!flavorId) return installs[0]!;
  const hit = installs.find((i) => i.flavor.id === flavorId || i.flavor.apiIndex === flavorId);
  if (!hit) {
    throw new Error(
      `No install for "${flavorId}". Found: ${installs.map((i) => i.flavor.id).join(", ")}`,
    );
  }
  return hit;
}

/** Opens (once per client) the local CASC storage and returns the driver. */
export async function openDriver(flavorId?: string, product?: string): Promise<Driver> {
  const d = load();
  const install = pickInstall(flavorId);
  const prod = product ?? PRODUCT_BY_API[install.flavor.apiIndex];
  const key = `${install.root}|${prod}`;
  if (key !== openKey) {
    await d.open({
      gameRoot: install.root,
      listfileCsv: listfileCsv(),
      ...(prod ? { product: prod } : {}),
    });
    openKey = key;
  }
  return d;
}

// ---------------------------------------------------------------------------
// Model search (listfile only, no CASC needed)
// ---------------------------------------------------------------------------

export interface ModelEntry {
  id: number;
  path: string;
}

// WMO group/LOD parts, same filter wow.export applies.
const WMO_PART = /(_\d\d\d_)|(_\d\d\d.wmo$)|(lod\d.wmo$)/;

let models: ModelEntry[] | null = null;

export async function loadModels(): Promise<ModelEntry[]> {
  if (models) return models;
  const out: ModelEntry[] = [];
  const rl = createInterface({ input: createReadStream(listfileCsv()), crlfDelay: Infinity });
  for await (const line of rl) {
    const sep = line.indexOf(";");
    if (sep < 1) continue;
    const path = line.slice(sep + 1).toLowerCase();
    if (path.endsWith(".m2") || (path.endsWith(".wmo") && !WMO_PART.test(path))) {
      out.push({ id: Number(line.slice(0, sep)), path });
    }
  }
  models = out;
  return out;
}

export function searchModels(
  list: ModelEntry[],
  query: string,
  kind: string,
  limit: number,
): ModelEntry[] {
  const q = query.toLowerCase().replace(/\\/g, "/").trim();
  const ext = kind === "m2" || kind === "wmo" ? `.${kind}` : "";
  const numeric = /^\d+$/.test(q) ? Number(q) : null;
  const terms = q.split(/\s+/).filter(Boolean);
  const hits: { e: ModelEntry; score: number }[] = [];
  for (const e of list) {
    if (ext && !e.path.endsWith(ext)) continue;
    if (numeric !== null) {
      if (e.id === numeric) hits.push({ e, score: 1000 });
      continue;
    }
    if (!terms.every((t) => e.path.includes(t))) continue;
    const base = e.path.slice(e.path.lastIndexOf("/") + 1);
    const exact = base === q || base.replace(/\.\w+$/, "") === q;
    hits.push({ e, score: (exact ? 100 : 0) - e.path.length });
  }
  return hits
    .sort((a, b) => b.score - a.score || a.e.path.localeCompare(b.e.path))
    .slice(0, limit)
    .map((h) => h.e);
}

/** Resolve a FileDataID or listfile path to an id. */
export async function resolveModel(spec: string | number): Promise<number | null> {
  const s = String(spec).trim();
  if (/^\d+$/.test(s)) return Number(s);
  const q = s.toLowerCase().replace(/\\/g, "/");
  const list = await loadModels();
  return list.find((e) => e.path === q)?.id ?? null;
}
