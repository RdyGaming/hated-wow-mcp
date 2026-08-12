import { resolve } from "node:path";

import { BUNDLED_DIR, cacheRoot, cacheRootReason } from "./paths.js";

/** Where the bundled API index, XSD and manifest live. */
export const DATA_DIR = BUNDLED_DIR;

// ---------------------------------------------------------------------------
// Game flavors
// ---------------------------------------------------------------------------

/**
 * A "flavor" is one shipped WoW client. Addon authors care about three things
 * that differ per flavor: the Interface number that goes in the .toc, the .toc
 * filename suffix the client looks for, and which API index describes it.
 *
 * `apiIndex` deliberately maps several flavors onto the same index — Blizzard
 * only publishes generated documentation for the three clients that are
 * actually running (retail, the current Classic progression client, and
 * Classic Era), so the older progression flavors reuse the nearest index.
 */
export interface Flavor {
  id: string;
  label: string;
  /** Current Interface number for the .toc `## Interface:` directive. */
  interfaceVersion: number;
  /** Filename suffix, e.g. `MyAddon_Mainline.toc`. Empty for the base .toc. */
  tocSuffix: string;
  /** Additional suffixes the client also accepts for this flavor. */
  altTocSuffixes: string[];
  /** Which bundled api-*.json describes this client. */
  apiIndex: "mainline" | "classic" | "vanilla";
}

export const FLAVORS: Record<string, Flavor> = {
  mainline: {
    id: "mainline",
    label: "Retail (Midnight)",
    interfaceVersion: 120007,
    tocSuffix: "_Mainline",
    altTocSuffixes: ["_Standard"],
    apiIndex: "mainline",
  },
  mists: {
    id: "mists",
    label: "Mists of Pandaria Classic",
    interfaceVersion: 50504,
    tocSuffix: "_Mists",
    altTocSuffixes: ["_Classic"],
    apiIndex: "classic",
  },
  cata: {
    id: "cata",
    label: "Cataclysm Classic",
    interfaceVersion: 40402,
    tocSuffix: "_Cata",
    altTocSuffixes: ["_Classic"],
    apiIndex: "classic",
  },
  wrath: {
    id: "wrath",
    label: "Wrath Classic / Titan Reforged",
    interfaceVersion: 38002,
    tocSuffix: "_Wrath",
    altTocSuffixes: ["_Classic", "-WOTLKC"],
    apiIndex: "classic",
  },
  tbc: {
    id: "tbc",
    label: "Burning Crusade Classic",
    interfaceVersion: 20506,
    tocSuffix: "_TBC",
    altTocSuffixes: ["_Classic", "-BCC"],
    apiIndex: "classic",
  },
  vanilla: {
    id: "vanilla",
    label: "Classic Era / Anniversary",
    interfaceVersion: 11509,
    tocSuffix: "_Vanilla",
    altTocSuffixes: ["_Classic"],
    apiIndex: "vanilla",
  },
};

export type FlavorId = keyof typeof FLAVORS;

export const FLAVOR_IDS = Object.keys(FLAVORS) as [string, ...string[]];

export function resolveFlavor(id?: string): Flavor {
  const key = (id ?? process.env.WOW_DEFAULT_FLAVOR ?? "mainline").toLowerCase();
  const flavor = FLAVORS[key];
  if (!flavor) {
    throw new Error(
      `Unknown flavor "${id}". Expected one of: ${Object.keys(FLAVORS).join(", ")}`,
    );
  }
  return flavor;
}

/**
 * Interface number -> flavor, used to tell a .toc author that the Interface
 * they wrote does not match the suffix on the filename.
 */
export function flavorForInterface(version: number): Flavor | undefined {
  // Interface numbers encode the patch: 120007 -> 12.0.7, 11509 -> 1.15.9.
  // Matching on the major version is what survives weekly patch bumps.
  const major = Math.floor(version / 10000);
  return Object.values(FLAVORS).find(
    (f) => Math.floor(f.interfaceVersion / 10000) === major,
  );
}

// ---------------------------------------------------------------------------
// Local WoW installation
// ---------------------------------------------------------------------------

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Directory name under the WoW install root for each flavor. */
const INSTALL_DIRS: Record<string, string> = {
  mainline: "_retail_",
  vanilla: "_classic_era_",
  mists: "_classic_",
  cata: "_classic_",
  wrath: "_classic_",
  tbc: "_classic_",
};

/** Places a stock WoW install lands, in the order we should try them. */
const DEFAULT_INSTALL_ROOTS = [
  "C:\\Program Files (x86)\\World of Warcraft",
  "C:\\Program Files\\World of Warcraft",
  "C:\\World of Warcraft",
  "D:\\World of Warcraft",
  "D:\\Games\\World of Warcraft",
  "/Applications/World of Warcraft",
];

export interface Installation {
  root: string;
  flavor: Flavor;
  /** `<root>/<flavor dir>` */
  flavorPath: string;
  addonsPath: string;
  /** Build number read from the flavor's .build.info / Build.txt, if present. */
  build?: string;
}

/**
 * Locates the WoW install. WOW_INSTALL_PATH wins; otherwise we probe the
 * standard locations. Returning every flavor found (rather than just one) lets
 * a tool target the client the user is actually working against.
 */
export function findInstallations(): Installation[] {
  const explicit = process.env.WOW_INSTALL_PATH?.trim();
  const roots = explicit ? [explicit] : DEFAULT_INSTALL_ROOTS;
  const found: Installation[] = [];

  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const [flavorId, dir] of Object.entries(INSTALL_DIRS)) {
      const flavorPath = join(root, dir);
      const addonsPath = join(flavorPath, "Interface", "AddOns");
      if (!existsSync(addonsPath)) continue;
      // Several Classic flavors share `_classic_`; only report the first hit.
      if (found.some((f) => f.flavorPath === flavorPath)) continue;
      found.push({
        root,
        flavor: FLAVORS[flavorId]!,
        flavorPath,
        addonsPath,
        ...(readBuild(root, dir) ? { build: readBuild(root, dir)! } : {}),
      });
    }
    if (found.length > 0 && !explicit) break;
  }

  return found;
}

/** Reads the installed build number out of `.build.info` in the install root. */
function readBuild(root: string, flavorDir: string): string | undefined {
  try {
    const info = readFileSync(join(root, ".build.info"), "utf8");
    const lines = info.split(/\r?\n/).filter(Boolean);
    const header = lines[0]!.split("|").map((h) => h.split("!")[0]!);
    const versionCol = header.indexOf("Version");
    const productCol = header.indexOf("Product");
    if (versionCol === -1) return undefined;

    // `.build.info` lists every installed product; match the one whose
    // product tag corresponds to this flavor directory.
    const wanted =
      flavorDir === "_retail_" ? "wow" : flavorDir === "_classic_era_" ? "wow_classic_era" : "wow_classic";
    for (const line of lines.slice(1)) {
      const cols = line.split("|");
      if (productCol === -1 || cols[productCol] === wanted) return cols[versionCol];
    }
  } catch {
    /* No .build.info is normal for some installs. */
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Addon workspace
// ---------------------------------------------------------------------------

/**
 * Root the addon file tools are confined to. Prefers WOW_ADDON_PATH, then the
 * AddOns folder of a detected install, so the common case needs no config.
 */
export function addonRoot(): string | null {
  const explicit = process.env.WOW_ADDON_PATH?.trim();
  if (explicit) return resolve(explicit);
  const install = findInstallations()[0];
  return install ? install.addonsPath : null;
}

/** Lists addon folder names under the resolved addon root. */
export function listAddons(): string[] {
  const root = addonRoot();
  if (!root || !existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
}

// ---------------------------------------------------------------------------
// Bundled data paths
// ---------------------------------------------------------------------------

/**
 * The first three ship inside the package and are read-only. The rest are
 * built by the sync scripts, so they resolve through `cacheRoot()` — a getter,
 * not a constant, because the location depends on environment that can change
 * between import time and first use. See src/paths.ts for the layout.
 */
export const DATA_PATHS = {
  apiIndex: (index: string) => join(DATA_DIR, `api-${index}.json`),
  uiSchema: join(DATA_DIR, "ui.xsd"),
  manifest: join(DATA_DIR, "manifest.json"),
  get uiSource() {
    return join(cacheRoot(), "uisource-index.json");
  },
  get uiCheckout() {
    return join(cacheRoot(), "uisource");
  },
  get files() {
    return join(cacheRoot(), "files-index.json");
  },
  get atlas() {
    return join(cacheRoot(), "atlas-index.json");
  },
} as const;

/**
 * `sync` is the sync's name — `ui-source`, `game-data`, `api`. The command we
 * suggest depends on how the server was installed: a clone has package scripts
 * to run, an installed copy does not and has to go through the bin.
 */
export function dataMissingMessage(what: string, sync: string): string {
  const command =
    cacheRootReason() === "cache"
      ? `npx -y hated-wow-mcp sync ${sync}`
      : `npm run sync-${sync}`;

  return [
    `The ${what} data set has not been built yet.`,
    "",
    `Run \`${command}\` to fetch and index it.`,
    "That sync downloads from public mirrors and needs outbound network access.",
    "",
    `It will be written to ${cacheRoot()}`,
  ].join("\n");
}
