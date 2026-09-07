import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  MONKEY_PLAYWRIGHT_REPORT,
  MONKEY_ROLES,
  monkeyFinding,
  validateRoleMatrix,
  type MonkeyFinding,
} from "./monkey-test-contract.js";
import { readMonkeyJson } from "./monkey-test-scan.js";

interface PlaywrightReportTest {
  projectName?: string;
  status?: string;
  /** What the spec DECLARED the outcome should be. `test.fail()` makes this "failed". */
  expectedStatus?: string;
  /** One entry per attempt (retries included), each with the outcome of that attempt. */
  results?: { status?: string }[];
  annotations?: { type?: string; description?: string }[];
}

interface PlaywrightReportSuite {
  title?: string;
  specs?: { title?: string; tests?: PlaywrightReportTest[] }[];
  suites?: PlaywrightReportSuite[];
}

interface PlaywrightReport {
  config?: { metadata?: Record<string, unknown> };
  suites?: PlaywrightReportSuite[];
  errors?: unknown[];
}

interface PlaywrightEvidenceTest extends PlaywrightReportTest {
  title: string;
}

function collectPlaywrightTests(
  suites: PlaywrightReportSuite[],
  parents: string[] = [],
): PlaywrightEvidenceTest[] {
  const tests: PlaywrightEvidenceTest[] = [];
  for (const suite of suites) {
    const path = suite.title ? [...parents, suite.title] : parents;
    for (const spec of suite.specs ?? []) {
      const title = [...path, spec.title ?? ""].filter(Boolean).join(" > ");
      for (const test of spec.tests ?? []) tests.push({ ...test, title });
    }
    tests.push(...collectPlaywrightTests(suite.suites ?? [], path));
  }
  return tests;
}

/**
 * Whether this test is evidence that the contract case ran and PASSED.
 *
 * `status: "expected"` alone is not that claim (MHB-03): it means the outcome matched the
 * spec's declaration, which a `test.fail()` spec satisfies by failing. Evidence therefore
 * requires all three: the run matched expectations, the expectation was "passed", and some
 * attempt actually passed. A missing `expectedStatus` is treated as "passed", which is
 * Playwright's own default for a spec that declares nothing.
 */
function contractCasePassed(test: PlaywrightReportTest): boolean {
  if (test.status !== "expected") return false;
  if (test.expectedStatus !== undefined && test.expectedStatus !== "passed") return false;
  return (test.results ?? []).some((result) => result.status === "passed");
}

function missingContractCases(tests: PlaywrightEvidenceTest[]): string[] {
  const missing: string[] = [];
  for (const project of ["desktop-chromium", "mobile-chrome"]) {
    for (const role of MONKEY_ROLES) {
      const found = tests.some(
        (test) =>
          test.projectName === project &&
          contractCasePassed(test) &&
          test.title.includes(`${role.id}: ${role.label}`) &&
          test.title.endsWith("route crawl"),
      );
      if (!found) missing.push(`${project}/${role.id}/route crawl`);
    }
    const money = tests.some(
      (test) =>
        test.projectName === project &&
        contractCasePassed(test) &&
        test.title.endsWith("money flow"),
    );
    if (!money) missing.push(`${project}/money flow`);
  }
  return missing;
}

export async function validatePlaywrightEvidence(
  root: string,
  runId: string,
): Promise<{ ok: boolean; detail: string }> {
  const report = await readMonkeyJson<PlaywrightReport>(join(root, MONKEY_PLAYWRIGHT_REPORT));
  if (!report) return { ok: false, detail: `${MONKEY_PLAYWRIGHT_REPORT} was not created` };
  if (report.config?.metadata?.kitMonkeyContract !== 1) {
    return { ok: false, detail: "report lacks kit monkey contract metadata" };
  }
  if (report.config.metadata.kitMonkeyRunId !== runId) {
    return { ok: false, detail: "report was not produced by the current monkey-test run" };
  }
  if ((report.errors?.length ?? 0) > 0) {
    return { ok: false, detail: `report contains ${report.errors!.length} top-level error(s)` };
  }
  const tests = collectPlaywrightTests(report.suites ?? []);
  const missing = missingContractCases(tests);
  if (missing.length > 0) {
    return { ok: false, detail: `missing successful contract cases: ${missing.join(", ")}` };
  }
  return { ok: true, detail: `${tests.length} Playwright contract case(s) verified` };
}

export async function runnerRoleMatrixFinding(
  root: string,
  env: NodeJS.ProcessEnv,
): Promise<MonkeyFinding | null> {
  const configuredPath = env.MONKEY_ROLE_MATRIX ?? ".kit/monkey-test/role-matrix.json";
  const path = resolve(root, configuredPath);
  try {
    if (!existsSync(path)) throw new Error(`Role matrix not found: ${configuredPath}`);
    validateRoleMatrix(await readMonkeyJson<unknown>(path));
    return null;
  } catch (error) {
    return monkeyFinding({
      severity: "critical",
      area: "authz",
      title: "Monkey role matrix invalid",
      repro: error instanceof Error ? error.message : String(error),
      file: configuredPath,
      fix: "Set configured to true after defining allowRoutes, denyRoutes, requiredText, and forbiddenText from the idempotent seed for every role.",
    });
  }
}
