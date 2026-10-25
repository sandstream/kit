import type { SecurityCheckResult } from "./check-security.js";

type Level = NonNullable<SecurityCheckResult["severity"]>;

interface OsvPackage {
  package?: { name?: string; version?: string; ecosystem?: string };
  vulnerabilities?: { id?: string }[];
  groups?: { max_severity?: string }[];
}

/** CVSS v3 bands: 9.0 critical, 7.0 high, 4.0 medium, below that low. */
export function osvSeverity(score: number): Level {
  if (score >= 9) return "critical";
  if (score >= 7) return "high";
  if (score >= 4) return "medium";
  return "low";
}

const LISTED = 10;
/** Names and versions come from a lockfile the scanner read, so they are untrusted text. */
const SAFE_NAME = /^[@\w.:/~+-]{1,214}$/;
const SAFE_VERSION = /^[\w.+~-]{1,64}$/;
const NPM_NAME = /^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/;

const safeName = (v: string | undefined) => (v !== undefined && SAFE_NAME.test(v) ? v : "?");
const safeVersion = (v: string | undefined) => (v !== undefined && SAFE_VERSION.test(v) ? v : "?");

interface Rating {
  severity: Level;
  notes: string[];
}

function scoresOf(p: OsvPackage): number[] {
  return (p.groups ?? [])
    .map((g) => Number.parseFloat(g.max_severity ?? ""))
    .filter((n) => Number.isFinite(n));
}

/** Groups osv gave no score, counting a package with no group at all as one. */
function unscoredCount(vulnerable: OsvPackage[]): number {
  return vulnerable.reduce((n, p) => {
    const groups = (p.groups ?? []).length;
    return n + Math.max(groups - scoresOf(p).length, groups === 0 ? 1 : 0);
  }, 0);
}

const hasMalware = (vulnerable: OsvPackage[]): boolean =>
  vulnerable.some((p) => (p.vulnerabilities ?? []).some((v) => v.id?.startsWith("MAL-")));

/**
 * The severity follows the worst score osv reports. A hole with no score is never rated below
 * `high`, since an unrated hole is not a safe one, and a malware advisory (a `MAL-` id) is critical
 * whatever its score.
 */
function rate(vulnerable: OsvPackage[]): Rating {
  const scores = vulnerable.flatMap(scoresOf);
  const worst = scores.length > 0 ? Math.max(...scores) : null;
  const unscored = unscoredCount(vulnerable);
  const malware = hasMalware(vulnerable);
  let severity: Level = worst === null ? "high" : osvSeverity(worst);
  if (unscored > 0 && severity !== "critical") severity = "high";
  if (malware) severity = "critical";
  const notes = [worst === null ? "no CVSS score" : `worst CVSS ${worst.toFixed(1)} (${severity})`];
  if (worst !== null && unscored > 0) notes.push(`${unscored} without a CVSS score`);
  if (malware) notes.push("malware advisory");
  return { severity, notes };
}

/** Plain npm package names only, and only when the whole list fits the row: nothing else is run. */
function npmUpdateCommand(vulnerable: OsvPackage[]): string | undefined {
  const names = vulnerable.map((p) => p.package?.name);
  const plain =
    vulnerable.every((p) => p.package?.ecosystem === "npm") &&
    names.length <= LISTED &&
    names.every((n) => n !== undefined && NPM_NAME.test(n));
  return plain ? `npm update ${names.join(" ")} --ignore-scripts` : undefined;
}

/**
 * The warning row for an `osv-scanner --format json` payload that holds at least one hole. Names and
 * versions come from the lockfile, so only plain package-name text reaches the row or the suggested
 * command, at most ten packages are listed, and anything else shows as `?`.
 */
export function osvFinding(name: string, stdout: string): SecurityCheckResult {
  const parsed = JSON.parse(stdout) as { results?: { packages?: OsvPackage[] }[] };
  const vulnerable = (parsed.results ?? [])
    .flatMap((r) => r.packages ?? [])
    .filter((p) => (p.vulnerabilities ?? []).length > 0);
  const count = vulnerable.reduce((n, p) => n + (p.vulnerabilities ?? []).length, 0);
  const { severity, notes } = rate(vulnerable);
  const names = vulnerable.map(
    (p) => `${safeName(p.package?.name)} ${safeVersion(p.package?.version)}`,
  );
  const more = names.length > LISTED ? ` +${names.length - LISTED} more` : "";
  const result: SecurityCheckResult = {
    category: "supply-chain",
    name,
    status: "warn",
    detail:
      `${count} known dependency vulnerability(ies) in ${vulnerable.length} package(s), ` +
      `${notes.join(", ")}: ${names.slice(0, LISTED).join(", ")}${more} -run: osv-scanner -r .`,
    severity,
  };
  const update = npmUpdateCommand(vulnerable);
  if (update) {
    result.suggestion = `${update}, then re-run kit check (a transitive package moves only if its parent's range allows the fixed version)`;
  }
  return result;
}
