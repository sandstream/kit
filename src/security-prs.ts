/**
 * Open security PRs ranked by advisory severity (zero-trust plan Z4, point 5).
 * Pure: `kit watch run` reads `gh` (open PRs, Dependabot alerts) and hands the
 * JSON here. A PR counts as a security PR only when an open advisory names the
 * package it bumps and the target version is at or past the first patched one.
 * Severity comes from the alert, never from the PR text.
 */

export type Severity = "critical" | "high" | "medium" | "low";
export type CiState = "failing" | "pending" | "passing" | "none";

export interface OpenPr {
  number: number;
  title: string;
  updatedAt: string;
  author?: { login: string; isBot: boolean };
  checks: { state: string }[];
}

export interface SecurityAlert {
  name: string;
  severity: Severity;
  patched: string;
}

export interface RankedPr {
  number: number;
  title: string;
  severity: Severity;
  ci: CiState;
  updatedAt: string;
}

const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low"];
const FAILED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"]);
const UNFINISHED = new Set(["PENDING", "QUEUED", "IN_PROGRESS", "WAITING", "EXPECTED"]);

const PACKAGE_NAME = /^@?[\w.-]+(\/[\w.-]+)?$/;
const PACKAGE_VERSION = /^\d[\w.+-]*$/;
const DEPENDABOT = new Set(["dependabot", "app/dependabot"]);

/**
 * Package and target version of a Dependabot title; null when the title is not a bump or
 * names something that is not a package and a version. The title is attacker-controlled
 * text, so only those two checked parts are ever shown or stored.
 */
export function bumpTarget(title: string): { name: string; to: string } | null {
  const m = /\bbump (\S+) from \S+ to (\S+)/i.exec(title);
  if (!m || !PACKAGE_NAME.test(m[1]) || !PACKAGE_VERSION.test(m[2])) return null;
  return { name: m[1], to: m[2] };
}

export function ciState(checks: { state: string }[]): CiState {
  if (checks.length === 0) return "none";
  if (checks.some((c) => FAILED.has(c.state))) return "failing";
  if (checks.some((c) => UNFINISHED.has(c.state))) return "pending";
  return "passing";
}

/** Compare dotted numeric versions; a non-numeric part counts as 0. */
function versionAtLeast(version: string, floor: string): boolean {
  const a = version.split(".").map((p) => Number.parseInt(p, 10) || 0);
  const b = floor.split(".").map((p) => Number.parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return true;
}

export function rankSecurityPrs(prs: OpenPr[], alerts: SecurityAlert[]): RankedPr[] {
  const ranked: RankedPr[] = [];
  for (const pr of prs) {
    // Anyone can title a PR "bump x from 1 to 2"; only Dependabot's own PRs count.
    if (!pr.author?.isBot || !DEPENDABOT.has(pr.author.login)) continue;
    const bump = bumpTarget(pr.title);
    if (!bump) continue;
    const fixed = alerts
      .filter((a) => a.name === bump.name && versionAtLeast(bump.to, a.patched))
      .sort((x, y) => SEVERITY_ORDER.indexOf(x.severity) - SEVERITY_ORDER.indexOf(y.severity));
    if (fixed.length === 0) continue;
    ranked.push({
      number: pr.number,
      title: `bump ${bump.name} to ${bump.to}`,
      severity: fixed[0].severity,
      ci: ciState(pr.checks),
      updatedAt: pr.updatedAt,
    });
  }
  return ranked.sort(
    (x, y) =>
      SEVERITY_ORDER.indexOf(x.severity) - SEVERITY_ORDER.indexOf(y.severity) ||
      x.updatedAt.localeCompare(y.updatedAt),
  );
}

/** One status-line segment, e.g. `sec-prs:2 critical #3 ci:failing`. null = nothing open. */
export function securityPrsLine(ranked: RankedPr[]): string | null {
  const top = ranked[0];
  if (!top) return null;
  return `sec-prs:${ranked.length} ${top.severity} #${top.number} ci:${top.ci}`;
}
