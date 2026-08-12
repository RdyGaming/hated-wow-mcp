#!/usr/bin/env node
/**
 * Summarises what moved between two data/manifest.json files.
 *
 * The weekly sync used to commit "chore(data): sync WoW API index" whether
 * Blizzard added four hundred functions or renamed one enum. For a server whose
 * whole value is knowing what the current API looks like, the size and shape of
 * each week's change is the interesting part — so it goes in the commit message.
 *
 * Usage: node manifest-diff.mjs <before.json> <after.json>
 * Prints a one-line subject, then a blank line, then a per-flavor body.
 */

import { readFileSync } from "node:fs";

const [beforePath, afterPath] = process.argv.slice(2);

const read = (p) => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};

const before = read(beforePath);
const after = read(afterPath);

if (!after) {
  process.stdout.write("chore(data): sync WoW API index\n");
  process.exit(0);
}

/** Counts we report on, in the order they appear in the body. */
const FIELDS = ["functions", "events", "tables", "globals", "cvars"];

const lines = [];
let totalAdded = 0;
let totalRemoved = 0;

for (const [flavor, counts] of Object.entries(after.flavors ?? {})) {
  const prior = before?.flavors?.[flavor];
  const deltas = [];

  for (const field of FIELDS) {
    const now = counts[field] ?? 0;
    const was = prior?.[field] ?? 0;
    const delta = now - was;
    if (delta === 0) continue;
    if (delta > 0) totalAdded += delta;
    else totalRemoved += -delta;
    deltas.push(`${delta > 0 ? "+" : ""}${delta} ${field}`);
  }

  if (deltas.length > 0) lines.push(`  ${flavor}: ${deltas.join(", ")}`);
}

// A patch can change signatures without changing any count. Saying "no net
// change" is honest; claiming nothing happened would not be.
const subject =
  lines.length === 0
    ? "chore(data): sync WoW API index (no net count change)"
    : `chore(data): sync WoW API index (+${totalAdded}/-${totalRemoved})`;

process.stdout.write(
  lines.length === 0 ? `${subject}\n` : `${subject}\n\n${lines.join("\n")}\n`,
);
