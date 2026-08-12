#!/usr/bin/env node
/**
 * Entry point for the data syncs when the server is installed rather than
 * cloned. An installed copy has no package scripts to run, so the three syncs
 * are exposed through one command:
 *
 *   npx hated-wow-mcp-sync all
 *   npx hated-wow-mcp-sync game-data -- --full
 *
 * Each sync keeps its own argument parsing, so this dispatches by spawning the
 * target rather than importing it — what a sync sees in process.argv is then
 * identical whether it was started from here or run directly.
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { isCheckout } from "../paths.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));

/** Sync name -> compiled module, in the order `all` should run them. */
const SYNCS = {
  api: "api.js",
  "ui-source": "ui-source.js",
  "game-data": "game-data.js",
} as const;

type SyncName = keyof typeof SYNCS;

const USAGE = [
  "Usage: hated-wow-mcp-sync <api|ui-source|game-data|all> [-- <args>]",
  "",
  "  api         Blizzard's generated API docs (ships bundled; git checkout only)",
  "  ui-source   Blizzard's shipped UI source and its symbol index (~50MB)",
  "  game-data   FileDataID listfile and texture atlas indexes (~17MB)",
  "  all         every sync that applies to this install, in order",
  "",
  "Extra arguments after -- go to the sync, e.g.:",
  "  hated-wow-mcp-sync game-data -- --full",
].join("\n");

function run(name: SyncName, args: string[]): number {
  const result = spawnSync(process.execPath, [join(HERE, SYNCS[name]), ...args], {
    stdio: "inherit",
  });
  return result.status ?? 1;
}

const [target, ...rest] = process.argv.slice(2);
const args = rest[0] === "--" ? rest.slice(1) : rest;

if (!target || target === "--help" || target === "-h") {
  process.stdout.write(`${USAGE}\n`);
  process.exit(target ? 0 : 1);
}

if (target === "all") {
  // The API index ships with the package; only a checkout can regenerate it.
  const names = (Object.keys(SYNCS) as SyncName[]).filter(
    (name) => name !== "api" || isCheckout(),
  );

  for (const name of names) {
    const code = run(name, args);
    if (code !== 0) {
      process.stderr.write(`\n${name} sync failed — stopping.\n`);
      process.exit(code);
    }
  }
  process.exit(0);
}

if (!(target in SYNCS)) {
  process.stderr.write(`Unknown sync "${target}".\n\n${USAGE}\n`);
  process.exit(1);
}

process.exit(run(target as SyncName, args));
