#!/usr/bin/env node
/**
 * Fetches the small public tables the model exporter needs at run time:
 *
 *   wowdev/WoWDBDefs ... column layouts (.dbd) for the DB2 tables the exporter
 *                        reads out of the local game files.
 *   wowdev/TACTKeys ..... decryption keys for the few encrypted CASC blocks.
 *
 * Neither is Blizzard data. The game files themselves are always read from the
 * local install, never downloaded. The FileDataID listfile comes from the
 * game-data sync (`sync game-data`), which this one expects to have run.
 *
 * Usage:
 *   npm run sync-model-data
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { cacheRoot } from "../paths.js";

const OUT_DIR = resolve(cacheRoot(), "wowexport");

const DBD_URL = "https://raw.githubusercontent.com/wowdev/WoWDBDefs/master/definitions/%s.dbd";
const TACT_URL = "https://raw.githubusercontent.com/wowdev/TACTKeys/master/WoW.txt";

/** Tables read by the exporters and the creature lookup. */
const DBD_TABLES = [
  "ModelFileData",
  "TextureFileData",
  "Creature",
  "CreatureDisplayInfo",
  "CreatureDisplayInfoExtra",
  "CreatureModelData",
] as const;

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "user-agent": "wow-mcp-server/sync" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.text();
}

async function main(): Promise<void> {
  await mkdir(resolve(OUT_DIR, "dbd"), { recursive: true });

  for (const table of DBD_TABLES) {
    const url = DBD_URL.replace("%s", table);
    process.stderr.write(`fetching ${url}\n`);
    await writeFile(resolve(OUT_DIR, "dbd", `${table}.dbd`), await fetchText(url), "utf8");
  }

  process.stderr.write(`fetching ${TACT_URL}\n`);
  const keys: Record<string, string> = {};
  for (const line of (await fetchText(TACT_URL)).split(/\r?\n/)) {
    const [name, key] = line.trim().split(" ");
    if (name?.length === 16 && key?.length === 32) keys[name.toLowerCase()] = key.toLowerCase();
  }
  await writeFile(resolve(OUT_DIR, "tact.json"), JSON.stringify(keys), "utf8");

  process.stderr.write(
    `\nmodel data ready in ${OUT_DIR} (${DBD_TABLES.length} tables, ${Object.keys(keys).length} keys)\n`,
  );
  if (!existsSync(resolve(cacheRoot(), ".cache", "community-listfile.csv"))) {
    process.stderr.write("The listfile is missing. Run the game-data sync too.\n");
  }
}

main().catch((err) => {
  process.stderr.write(`model-data sync failed: ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
