/**
 * Wording for the bumblebee row when its threat-intel catalogs are old. The catalogs ship inside the
 * pinned release, so their age is the age of that release. A green row next to an age reads as an
 * approval, so the text says what a pass does and does not cover, and why the catalogs are old.
 */

/** From this many days the detail text switches from a note to a warning. */
const STALE_AFTER_DAYS = 90;

/** Past this many days the row stops being `pass`: a pass this old is not evidence about newer compromises. */
export const WARN_AFTER_DAYS = 180;

export function staleCatalogStatus(ageDays: number): "pass" | "warn" {
  return ageDays > WARN_AFTER_DAYS ? "warn" : "pass";
}

type Update = { latest: string; pinned: string } | null;

function why(update: Update): string {
  return update
    ? `bumblebee ${update.latest} is available upstream (pinned ${update.pinned})`
    : "no newer bumblebee release exists upstream, and upstream main may hold newer entries this release cannot load";
}

/**
 * What a clean scan covered. The default `baseline` profile reads this machine's global and user
 * package roots and agent configs, never the repository: run in a project with no manifest at all,
 * it still reported "no known exposures (86 packages)", which reads as a verdict on the project.
 */
function scannedScope(packagesScanned: number, profile: string): string {
  if (profile === "baseline") {
    return `${packagesScanned} packages on this machine (baseline profile: global and user package roots and agent configs, not this repository's dependencies; KIT_BUMBLEBEE_PROFILE=project with KIT_BUMBLEBEE_ROOTS=. scans the repository)`;
  }
  return `${packagesScanned} packages, profile=${profile}`;
}

/**
 * Mark a row from the `baseline` profile as evidence about the machine, not the repository. A
 * control-coverage map (`kit coverage --verify`) must not read that pass as a repository control
 * verified: NIST 800-53 SR read "verified" on this row alone. Other profiles are left as they are.
 */
export function withRepositoryScope<T extends object>(
  row: T,
  profile: string,
): T & { outsideRepository?: true } {
  return profile === "baseline" ? { ...row, outsideRepository: true as const } : row;
}

export function scannedHead(packagesScanned: number, profile: string): string {
  const scope = scannedScope(packagesScanned, profile);
  return profile === "baseline"
    ? `no known exposures in ${scope}`
    : `no known exposures (${scope})`;
}

export function staleCatalogDetail(
  packagesScanned: number,
  ageDays: number,
  update: Update,
  profile = "baseline",
): string {
  const head = `Compared ${scannedScope(packagesScanned, profile)} with the pinned catalogs`;
  if (ageDays <= STALE_AFTER_DAYS) {
    return `${head}; note: threat-intel catalogs are ${ageDays} days old (advisory, not gated); ${why(update)}`;
  }
  const gate = ageDays > WARN_AFTER_DAYS ? "warning, not a failure" : "advisory, not gated";
  return `${head}; WARNING: threat-intel catalogs are ${ageDays} days old, so this pass is not evidence about newer ones (${gate}); ${why(update)}`;
}

/** What replaces Socket in a local-first check, without promising fresh threat data. */
export const LOCAL_COVER =
  "Local cover: osv-scanner (a vulnerability database), kit's own supply-chain checks, and bumblebee, which matches a fixed list of known compromises that is only as new as its release, not live threat data";
