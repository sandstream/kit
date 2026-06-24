/**
 * GuardDog (DataDog, OSS) — local behavioral-malware heuristics for npm/PyPI
 * packages (Semgrep rules on source + metadata heuristics). kit's local-first
 * answer to Socket's behavioral niche (#105): unlike Socket it runs locally and
 * doesn't upload your manifest.
 *
 * This module is the PURE classifier (fixture-tested). The check wiring lives in
 * check-security.ts and is OPT-IN (KIT_GUARDDOG=1) — GuardDog needs Semgrep, and
 * `verify` fetches/scans each dep, so it's too heavy for the default local check.
 */
import type { SecurityCheckResult } from "./check-security.js";

/** One package's GuardDog result (`guarddog npm verify|scan --output-format=json`). */
export interface GuardDogResult {
  package?: string;
  /** count of detected malware indicators for this package */
  issues?: number;
  /** rule-name → error message; non-empty means some rules could NOT run */
  errors?: Record<string, string>;
  results?: Record<string, unknown>;
}

/**
 * Classify GuardDog JSON output (a single object or an array of them) — PURE.
 *
 * FAIL CLOSED (the recurring lesson): a `pass` requires a COMPLETE scan. GuardDog
 * reports per-rule `errors` (e.g. "unable to find semgrep binary") — when its
 * source rules couldn't run, `issues: 0` is meaningless, so an errored-but-zero
 * scan is a `warn` ("incomplete — UNVERIFIED"), never a pass. Real indicators
 * (issues > 0) always fail regardless.
 */
export function classifyGuardDog(stdout: string): SecurityCheckResult {
  const base = { category: "supply-chain", name: "guarddog (malware)" } as const;

  let entries: GuardDogResult[];
  try {
    const j = JSON.parse(stdout);
    entries = Array.isArray(j) ? j : [j];
  } catch {
    return {
      ...base,
      status: "warn",
      detail: "guarddog produced no parseable result — malware scan UNVERIFIED",
      severity: "medium",
    };
  }

  if (entries.length === 0) {
    return {
      ...base,
      status: "warn",
      detail: "guarddog returned no results — UNVERIFIED",
      severity: "medium",
    };
  }

  let totalIssues = 0;
  let errored = 0;
  for (const e of entries) {
    totalIssues += Number(e.issues ?? 0);
    if (e.errors && Object.keys(e.errors).length > 0) errored++;
  }

  if (totalIssues > 0) {
    return {
      ...base,
      status: "fail",
      detail: `${totalIssues} malware indicator(s) across ${entries.length} package(s) -run: guarddog npm verify`,
      severity: "critical",
    };
  }

  // Zero issues but some rules errored → the scan didn't actually complete.
  if (errored > 0) {
    return {
      ...base,
      status: "warn",
      detail: `guarddog rules failed to run on ${errored}/${entries.length} package(s) (e.g. missing semgrep) — malware scan INCOMPLETE/UNVERIFIED`,
      severity: "medium",
      suggestion: "mise use pipx:semgrep  (GuardDog's source rules need semgrep)",
    };
  }

  // Complete scan, zero indicators — the only path that earns a pass.
  return {
    ...base,
    status: "pass",
    detail: `no malware indicators (${entries.length} package(s) scanned)`,
  };
}
