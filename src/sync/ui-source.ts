#!/usr/bin/env node
/**
 * Clones Blizzard's shipped interface source and builds a symbol index of it.
 *
 * This is the "how does Blizzard actually do it" corpus: every XML template an
 * addon can inherit, every mixin it can reuse, and the full Lua/XML of the 348
 * Blizzard_* packages that ship with the client.
 *
 * Source: Gethe/wow-ui-source, an automated export of the interface files
 * Blizzard publishes with each patch.
 *
 * Usage:
 *   npm run sync-ui-source              # retail
 *   npm run sync-ui-source -- classic   # a specific flavor
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { cacheRoot } from "../paths.js";

// A ~48MB checkout plus its index — writable cache root, not the package.
const DATA_DIR = cacheRoot();
const CHECKOUT_DIR = resolve(DATA_DIR, "uisource");

const REPO = "https://github.com/Gethe/wow-ui-source.git";

/** Flavor -> upstream branch. Matches FLAVOR_BRANCHES in sync-wow-data.ts. */
const BRANCHES: Record<string, string> = {
  mainline: "live",
  classic: "classic",
  vanilla: "classic_era",
};

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

/**
 * Blizzard ships filenames long enough that a checkout blows past Windows'
 * 260-character MAX_PATH once the clone sits more than ~150 characters deep
 * (`Blizzard_ProfessionsCustomerOrdersRecipeCategoryList.lua` alone is 108).
 * Git then reports "Clone succeeded, but checkout failed", which is fatal here
 * but reads like a warning. `-c` scopes this to our own invocations rather than
 * writing to the user's global git config; it is a no-op off Windows.
 */
const GIT_OPTS = ["-c", "core.longpaths=true"];

function git(args: string[], cwd: string): string {
  return execFileSync("git", [...GIT_OPTS, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * Clones at depth 1, or fast-forwards an existing checkout. Shallow is
 * deliberate: the history of this mirror is large and nothing here needs it.
 */
function ensureCheckout(branch: string): string {
  const dir = join(CHECKOUT_DIR, branch);

  if (existsSync(join(dir, ".git"))) {
    process.stderr.write(`[${branch}] updating existing checkout…\n`);
    try {
      git(["fetch", "--depth", "1", "origin", branch], dir);
      git(["reset", "--hard", `origin/${branch}`], dir);
      return dir;
    } catch (err) {
      process.stderr.write(
        `[${branch}] update failed (${(err as Error).message.split("\n")[0]}); re-cloning\n`,
      );
    }
  }

  process.stderr.write(`[${branch}] cloning ${REPO}…\n`);
  execFileSync(
    "git",
    [...GIT_OPTS, "clone", "--depth", "1", "--branch", branch, REPO, dir],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  return dir;
}

// ---------------------------------------------------------------------------
// Indexing
// ---------------------------------------------------------------------------

export interface UiFile {
  /** Path relative to the checkout root, forward-slashed. */
  path: string;
  /** Owning Blizzard_* package, or "" for files outside AddOns. */
  pkg: string;
  ext: "lua" | "xml" | "toc";
  lines: number;
  bytes: number;
}

export interface UiTemplate {
  name: string;
  /** Element type: Frame, Button, CheckButton, Texture, … */
  type: string;
  inherits: string[];
  mixin: string[];
  file: string;
  line: number;
}

export interface UiMixin {
  name: string;
  /** Mixins this one is composed from, via CreateFromMixins. */
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
  /** Global strings from GlobalStrings-style files: NAME -> localized text. */
  globalStrings: Record<string, string>;
}

function walk(dir: string, root: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, root, out);
    else if (/\.(lua|xml|toc)$/i.test(entry.name)) out.push(full);
  }
}

/** `Interface/AddOns/Blizzard_Foo/Bar.lua` -> `Blizzard_Foo`. */
function packageOf(relPath: string): string {
  const parts = relPath.split("/");
  const i = parts.indexOf("AddOns");
  return i !== -1 && parts[i + 1] ? parts[i + 1]! : "";
}

/**
 * Extracts virtual (inheritable) templates from a UI XML file.
 *
 * Only `virtual="true"` elements are indexed — a non-virtual frame is a
 * concrete piece of Blizzard's UI, not something an addon can inherit, and
 * including them would bury the useful results.
 */
function indexTemplates(source: string, file: string): UiTemplate[] {
  const out: UiTemplate[] = [];
  // Match an opening tag and capture its attribute block. Tags routinely span
  // several lines, so this is intentionally newline-tolerant.
  const tagRe = /<([A-Z]\w*)\b([^>]*?)\/?>/gs;

  for (const m of source.matchAll(tagRe)) {
    const attrs = m[2] ?? "";
    if (!/\bvirtual\s*=\s*"true"/i.test(attrs)) continue;

    const name = /\bname\s*=\s*"([^"]+)"/i.exec(attrs)?.[1];
    if (!name) continue;

    const inherits = /\binherits\s*=\s*"([^"]+)"/i.exec(attrs)?.[1] ?? "";
    const mixin = /\bmixin\s*=\s*"([^"]+)"/i.exec(attrs)?.[1] ?? "";
    const secureMixin = /\bsecureMixin\s*=\s*"([^"]+)"/i.exec(attrs)?.[1] ?? "";

    const split = (v: string): string[] =>
      v.split(",").map((s) => s.trim()).filter(Boolean);

    out.push({
      name,
      type: m[1]!,
      inherits: split(inherits),
      mixin: [...split(mixin), ...split(secureMixin)],
      file,
      line: source.slice(0, m.index).split("\n").length,
    });
  }

  return out;
}

/** Extracts mixin tables and their methods from a Lua file. */
function indexMixins(source: string, file: string): UiMixin[] {
  const byName = new Map<string, UiMixin>();
  const lineAt = (offset: number): number => source.slice(0, offset).split("\n").length;

  // `FooMixin = {}` or `FooMixin = CreateFromMixins(A, B)`
  const declRe = /^(\w*Mixin)\s*=\s*(?:\{\s*\}|CreateFromMixins\(([^)]*)\))/gm;
  for (const m of source.matchAll(declRe)) {
    const name = m[1]!;
    byName.set(name, {
      name,
      composedFrom: (m[2] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      methods: [],
      file,
      line: lineAt(m.index!),
    });
  }

  // `function FooMixin:Bar(` — also picks up methods on mixins declared in
  // another file, which is common for the larger UI packages.
  const methodRe = /^function\s+(\w*Mixin)[:.](\w+)\s*\(/gm;
  for (const m of source.matchAll(methodRe)) {
    const name = m[1]!;
    const method = m[2]!;
    let entry = byName.get(name);
    if (!entry) {
      entry = { name, composedFrom: [], methods: [], file, line: lineAt(m.index!) };
      byName.set(name, entry);
    }
    entry.methods.push(method);
  }

  for (const entry of byName.values()) entry.methods.sort();
  return [...byName.values()];
}

/** `FOO_BAR = "text";` from GlobalStrings-style files. */
function indexGlobalStrings(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of source.matchAll(/^([A-Z][A-Z0-9_]{2,})\s*=\s*"((?:[^"\\]|\\.)*)"/gm)) {
    out[m[1]!] = m[2]!.replace(/\\"/g, '"');
  }
  return out;
}

async function buildIndex(flavor: string): Promise<UiSourceIndex> {
  const branch = BRANCHES[flavor];
  if (!branch) throw new Error(`unknown flavor: ${flavor}`);

  const dir = ensureCheckout(branch);
  const commit = git(["rev-parse", "HEAD"], dir).trim();

  process.stderr.write(`[${flavor}] indexing…\n`);

  const absFiles: string[] = [];
  walk(join(dir, "Interface"), dir, absFiles);

  const files: UiFile[] = [];
  const templates: UiTemplate[] = [];
  const mixins: UiMixin[] = [];
  let globalStrings: Record<string, string> = {};
  const packages = new Set<string>();

  for (const abs of absFiles) {
    const rel = relative(dir, abs).split(sep).join("/");
    const source = readFileSync(abs, "utf8");
    const ext = rel.toLowerCase().endsWith(".lua")
      ? "lua"
      : rel.toLowerCase().endsWith(".xml")
        ? "xml"
        : "toc";

    const pkg = packageOf(rel);
    if (pkg) packages.add(pkg);

    files.push({
      path: rel,
      pkg,
      ext,
      lines: source.split("\n").length,
      bytes: statSync(abs).size,
    });

    if (ext === "xml") {
      templates.push(...indexTemplates(source, rel));
    } else if (ext === "lua") {
      mixins.push(...indexMixins(source, rel));
      if (/GlobalStrings|Constants/i.test(rel)) {
        globalStrings = { ...globalStrings, ...indexGlobalStrings(source) };
      }
    }
  }

  // Merge mixin entries that span multiple files: keep the declaration site as
  // the canonical location and union the methods found elsewhere.
  const mergedMixins = new Map<string, UiMixin>();
  for (const m of mixins) {
    const existing = mergedMixins.get(m.name);
    if (!existing) {
      mergedMixins.set(m.name, m);
      continue;
    }
    existing.methods = [...new Set([...existing.methods, ...m.methods])].sort();
    if (m.composedFrom.length && !existing.composedFrom.length) {
      existing.composedFrom = m.composedFrom;
      existing.file = m.file;
      existing.line = m.line;
    }
  }

  const finalMixins = [...mergedMixins.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  templates.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.path.localeCompare(b.path));

  return {
    flavor,
    branch,
    commit,
    generatedAt: new Date().toISOString(),
    checkoutDir: dir,
    counts: {
      files: files.length,
      packages: packages.size,
      templates: templates.length,
      mixins: finalMixins.length,
      mixinMethods: finalMixins.reduce((n, m) => n + m.methods.length, 0),
      globalStrings: Object.keys(globalStrings).length,
    },
    packages: [...packages].sort(),
    files,
    templates,
    mixins: finalMixins,
    globalStrings,
  };
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const requested = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const flavors = requested.length > 0 ? requested : ["mainline"];

  await mkdir(CHECKOUT_DIR, { recursive: true });

  const indexes: Record<string, UiSourceIndex> = {};
  for (const flavor of flavors) {
    indexes[flavor] = await buildIndex(flavor);
    process.stderr.write(
      `[${flavor}] ${JSON.stringify(indexes[flavor]!.counts)}\n`,
    );
  }

  const target = resolve(DATA_DIR, "uisource-index.json");
  await writeFile(target, JSON.stringify(indexes), "utf8");
  process.stderr.write(`\nwrote ${target}\nDone.\n`);
}

main().catch((err) => {
  process.stderr.write(`sync-ui-source failed: ${(err as Error).stack}\n`);
  process.exit(1);
});
