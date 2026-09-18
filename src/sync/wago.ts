/**
 * wago.tools build lookup, kept apart from the sync script so it can be tested
 * without running a sync (the scripts start work as soon as they are imported).
 *
 * The atlas comes from wago's DB2 exports, which are keyed by game build. Asking
 * for "latest" leaves it to wago to decide which client that means, and it
 * cannot mean four things at once. Each client publishes under its own product
 * name, so the build to request is the newest one under that name.
 */

/** Index key -> the wago product that holds that client's builds. */
export const WAGO_PRODUCT: Record<string, string> = {
  mainline: "wow",
  classic: "wow_classic",
  vanilla: "wow_classic_era",
  forever: "wow_classic_beta",
};

export interface WagoBuild {
  version: string;
  created_at: string;
  /** Background-download builds are staging copies, not what players run. */
  is_bgdl?: boolean;
}

/**
 * The newest real build for a product, e.g. "1.60.1.69913", or undefined when
 * wago lists nothing for it. Background-download entries are skipped.
 */
export function pickLatestBuild(
  builds: Record<string, WagoBuild[] | undefined>,
  product: string,
): string | undefined {
  const candidates = (builds[product] ?? []).filter((b) => b.version && !b.is_bgdl);
  candidates.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  return candidates[0]?.version;
}
