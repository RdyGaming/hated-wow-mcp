/**
 * Where the server's two kinds of data live.
 *
 * The package ships a small read-only set — the API indexes, the XSD and the
 * manifest, about 9MB — and that is the only thing npm ever carries. Everything
 * heavy (the UI source checkout, the listfile and atlas indexes, ~70MB) is
 * built by the sync scripts at runtime and has to land somewhere writable.
 *
 * Writing it back into the package directory is what stops this server from
 * being installable with npx: an npx cache is not reliably writable, and when
 * it is, npm garbage-collects it and the sync is lost. So heavy data resolves
 * to the OS cache directory instead, and nothing ever writes inside the
 * package.
 *
 * A git checkout is exempt. Contributors expect `data/` next to the source, and
 * anyone already running the server this way keeps their existing sync rather
 * than silently re-downloading 70MB into a new location.
 */

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Package root: one level up from `src/` in dev, from `dist/` when built. */
export const PKG_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

/** Read-only data that ships inside the npm package. */
export const BUNDLED_DIR = join(PKG_ROOT, "data");

/** The heavy artifacts the sync scripts produce, relative to the cache root. */
const SYNCED_ARTIFACTS = [
  "uisource",
  "uisource-index.json",
  "files-index.json",
  "atlas-index.json",
] as const;

export type CacheRootReason =
  | "env" // WOW_MCP_DATA_DIR was set
  | "checkout" // running from a git clone
  | "legacy" // a previous sync already lives in the package dir
  | "cache"; // default: OS cache directory

let resolved: { dir: string; reason: CacheRootReason } | null = null;

/** Per-platform user cache directory, following each platform's convention. */
function osCacheDir(): string {
  const home = homedir();
  if (process.platform === "win32") {
    const base =
      process.env.LOCALAPPDATA ?? process.env.APPDATA ?? join(home, "AppData", "Local");
    return join(base, "hated-wow-mcp", "Cache");
  }
  if (process.platform === "darwin") {
    return join(home, "Library", "Caches", "hated-wow-mcp");
  }
  return join(process.env.XDG_CACHE_HOME ?? join(home, ".cache"), "hated-wow-mcp");
}

function resolveCacheRoot(): { dir: string; reason: CacheRootReason } {
  const explicit = process.env.WOW_MCP_DATA_DIR?.trim();
  if (explicit) return { dir: resolve(explicit), reason: "env" };

  // A clone has .git; keep data/ beside the source where contributors expect it.
  if (existsSync(join(PKG_ROOT, ".git"))) {
    return { dir: BUNDLED_DIR, reason: "checkout" };
  }

  // Installed copy that was synced under the old layout — don't strand ~70MB.
  if (SYNCED_ARTIFACTS.some((name) => existsSync(join(BUNDLED_DIR, name)))) {
    return { dir: BUNDLED_DIR, reason: "legacy" };
  }

  return { dir: osCacheDir(), reason: "cache" };
}

/** Directory the sync scripts write to and the heavy loaders read from. */
export function cacheRoot(): string {
  resolved ??= resolveCacheRoot();
  return resolved.dir;
}

/** Why {@link cacheRoot} picked where it did — surfaced by `wow_data_status`. */
export function cacheRootReason(): CacheRootReason {
  resolved ??= resolveCacheRoot();
  return resolved.reason;
}

/** Creates the cache root (and the download scratch dir) before a sync writes. */
export function ensureCacheRoot(): string {
  const dir = cacheRoot();
  mkdirSync(join(dir, ".cache"), { recursive: true });
  return dir;
}

/** True when heavy data shares the package directory rather than the OS cache. */
export function cacheIsInPackage(): boolean {
  return cacheRoot() === BUNDLED_DIR;
}

/**
 * True when the server is running from a git clone rather than an install.
 * Regenerating the bundled data only makes sense here — an installed copy gets
 * fresh API indexes by upgrading the package, not by writing into node_modules.
 */
export function isCheckout(): boolean {
  return existsSync(join(PKG_ROOT, ".git"));
}
