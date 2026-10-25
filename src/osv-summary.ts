import type { SecurityCheckResult } from "./check-security.js";

type Level = NonNullable<SecurityCheckResult["severity"]>;

interface OsvPackage {
  package?: { name?: string; version?: string; ecosystem?: string };
  vulnerabilities?: unknown[];
  groups?: { max_severity?: string }[];
}

/** CVSS v3 bands: 9.0 critical, 7.0 high, 4.0 medium, below that low. */
export function osvSeverity(score: number): Level {
  if (score >= 9) return "critical";
  if (score >= 7) return "high";
  if (score >= 4) return "medium";
  return "low";
}

/**
 * The warning row for an `osv-scanner --format json` payload that holds at least one hole. The row
 * takes its severity from the worst score osv reports. A fixed "high" made a medium finding read as
 * urgent. With no score at all the row stays `high` and says why, since an unrated hole is not a
 * safe one. Names the packages, and offers `npm update` when every one of them is an npm package.
 */
export function osvFinding(name: string, stdout: string): SecurityCheckResult {
  const parsed = JSON.parse(stdout) as { results?: { packages?: OsvPackage[] }[] };
  const vulnerable = (parsed.results ?? [])
    .flatMap((r) => r.packages ?? [])
    .filter((p) => (p.vulnerabilities ?? []).length > 0);
  const count = vulnerable.reduce((n, p) => n + (p.vulnerabilities ?? []).length, 0);
  const scores = vulnerable
    .flatMap((p) => p.groups ?? [])
    .map((g) => Number.parseFloat(g.max_severity ?? ""))
    .filter((n) => Number.isFinite(n));
  const worst = scores.length > 0 ? Math.max(...scores) : null;
  const severity: Level = worst === null ? "high" : osvSeverity(worst);
  const rating = worst === null ? "no CVSS score" : `worst CVSS ${worst.toFixed(1)} (${severity})`;
  const names = vulnerable.map((p) => `${p.package?.name ?? "?"} ${p.package?.version ?? "?"}`);
  const result: SecurityCheckResult = {
    category: "supply-chain",
    name,
    status: "warn",
    detail:
      `${count} known dependency vulnerability(ies) in ${vulnerable.length} package(s), ${rating}: ` +
      `${names.join(", ")} -run: osv-scanner -r .`,
    severity,
  };
  if (vulnerable.every((p) => p.package?.ecosystem === "npm")) {
    const list = vulnerable.map((p) => p.package?.name).join(" ");
    result.suggestion = `npm update ${list} --ignore-scripts, then re-run kit check (a transitive package moves only if its parent's range allows the fixed version)`;
  }
  return result;
}
