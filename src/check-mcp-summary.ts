/**
 * Compact `kit_check` payload for the MCP surface.
 *
 * Measured on this repo: the standing surface (initialize instructions + tools/list) is
 * ~7.4 KB and is paid ONCE per session, while one full `kit_check` response is ~9.8 KB and is
 * paid on EVERY call — and an agent in a check → fix → check loop calls it repeatedly. The
 * number that dominates the context bill is the output, not the schema.
 *
 * Almost every one of those calls asks the same question: is it green, and if not, what broke.
 * The full pass list answers a question nobody asked. So the response carries the verdict and
 * every non-passing row in full, and the complete run is written to a file whose path comes
 * back as a reference the agent can read when it genuinely needs the rest.
 *
 * Two rules this module exists to keep, both learned from `scan-diff.ts`:
 *
 * 1. **A summary must never read as a pass.** Only `pass` rows are dropped. A `skip` stays,
 *    because a skip is the coverage story — "stopped looking" must not compress into
 *    "stopped failing" — and any row flagged `didNotRun` stays even if something later
 *    decides skips are noise.
 * 2. **A partial run must never read as a full one.** `scope` is carried verbatim, so a
 *    `--category`-narrowed green cannot be mistaken for a whole-repo green.
 */
import { checkRunToJsonChecks, type CheckRunResult, type CheckCategory } from "./check-run.js";
import type { JsonCheck } from "./cli-checks-shared.js";
import type { CheckVerdict } from "./check-verdict.js";

export interface CheckSummaryCounts {
  passed: number;
  failed: number;
  warnings: number;
  skipped: number;
  /** Checks that could not run — kept separate because these are lost coverage, not results. */
  didNotRun: number;
}

export interface CheckSummary {
  ok: boolean;
  /** Non-null only for a narrowed run: the dimensions that actually ran. */
  scope: CheckCategory[] | null;
  dimensions: CheckVerdict["dimensions"];
  failed: CheckVerdict["failed"];
  /** Every row that is not a plain pass, in full. */
  findings: JsonCheck[];
  counts: CheckSummaryCounts;
  /** Always true, so a consumer can tell this payload from the complete one. */
  summarized: true;
  /** How many passing rows were left out. Their names live in the detail document. */
  passesOmitted: number;
  /**
   * Where the complete run was written. Absent when it could not be written — and then
   * the caller must send the full payload instead, because a reference that resolves to
   * nothing is worse than a verbose answer.
   */
  detail?: { path: string; hint: string };
}

/** True for a row that carries information about a problem or about lost coverage. */
function isFinding(check: JsonCheck): boolean {
  return check.status !== "pass" || check.didNotRun === true;
}

export function summarizeCheckRun(
  run: CheckRunResult,
  detail?: { path: string; hint: string },
): CheckSummary {
  const rows = checkRunToJsonChecks(run);
  const findings = rows.filter(isFinding);
  const counts: CheckSummaryCounts = {
    passed: rows.filter((c) => c.status === "pass").length,
    failed: rows.filter((c) => c.status === "fail").length,
    warnings: rows.filter((c) => c.status === "warn").length,
    skipped: rows.filter((c) => c.status === "skip").length,
    didNotRun: rows.filter((c) => c.didNotRun === true).length,
  };
  return {
    ok: run.ok,
    scope: run.scope,
    dimensions: run.verdict.dimensions,
    failed: run.verdict.failed,
    findings,
    counts,
    summarized: true,
    passesOmitted: rows.length - findings.length,
    ...(detail ? { detail } : {}),
  };
}

/** The complete run, in the shape `kit_check` has always returned. */
export function fullCheckPayload(run: CheckRunResult): Record<string, unknown> {
  return {
    ok: run.ok,
    scope: run.scope,
    dimensions: run.verdict.dimensions,
    failed: run.verdict.failed,
    tools: run.tools,
    services: run.services,
    secrets: run.secrets.keys,
    skills: run.skills,
    hooks: run.hooks,
    webSearch: run.webSearch,
    deploy: run.deploy,
    security: run.security,
    tests: run.tests,
    locks: run.locks,
  };
}
