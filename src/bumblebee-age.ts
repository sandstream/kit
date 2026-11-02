/**
 * Wording for the bumblebee row when its threat-intel catalogs are old. The catalogs ship inside the
 * pinned release, so their age is the age of that release. A green row next to an age reads as an
 * approval, so the text says what a pass does and does not cover, and why the catalogs are old.
 */

/** From this many days the row warns instead of noting. Advisory either way, never gated. */
const STALE_AFTER_DAYS = 90;

type Update = { latest: string; pinned: string } | null;

function why(update: Update): string {
  return update
    ? `bumblebee ${update.latest} is available upstream (pinned ${update.pinned})`
    : "no newer bumblebee release exists upstream, and upstream main may hold newer entries this release cannot load";
}

export function staleCatalogDetail(
  packagesScanned: number,
  ageDays: number,
  update: Update,
): string {
  const head = `no known exposures (${packagesScanned} packages)`;
  if (ageDays <= STALE_AFTER_DAYS) {
    return `${head}; note: threat-intel catalogs are ${ageDays} days old (advisory, not gated); ${why(update)}`;
  }
  return `${head}; WARNING: threat-intel catalogs are ${ageDays} days old, so this pass is not evidence about newer ones (advisory, not gated); ${why(update)}`;
}

/** What replaces Socket in a local-first check, without promising fresh threat data. */
export const LOCAL_COVER =
  "Local cover: osv-scanner (a vulnerability database), kit's own supply-chain checks, and bumblebee, which matches a fixed list of known compromises that is only as new as its release, not live threat data";
