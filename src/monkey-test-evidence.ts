import { existsSync, readFileSync } from "node:fs";
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
  stats?: { expected?: number; unexpected?: number; skipped?: number; flaky?: number };
}

interface PlaywrightEvidenceTest extends PlaywrightReportTest {
  title: string;
  suitePath: string[];
  specTitle: string;
}

const MONKEY_PROJECTS = ["desktop-chromium", "mobile-chrome"] as const;

function collectPlaywrightTests(
  suites: PlaywrightReportSuite[],
  parents: string[] = [],
): PlaywrightEvidenceTest[] {
  const tests: PlaywrightEvidenceTest[] = [];
  for (const suite of suites) {
    const path = suite.title ? [...parents, suite.title] : parents;
    for (const spec of suite.specs ?? []) {
      const specTitle = spec.title ?? "";
      const title = [...path, specTitle].filter(Boolean).join(" > ");
      for (const test of spec.tests ?? [])
        tests.push({ ...test, title, suitePath: path, specTitle });
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

function contractCaseProblems(tests: PlaywrightEvidenceTest[]): string[] {
  const missing: string[] = [];
  for (const project of MONKEY_PROJECTS) {
    for (const role of MONKEY_ROLES) {
      const matches = tests.filter(
        (test) =>
          test.projectName === project &&
          test.suitePath.at(-1) === `${role.id}: ${role.label}` &&
          test.specTitle === "route crawl",
      );
      if (matches.length > 1) missing.push(`duplicate ${project}/${role.id}/route crawl`);
      else if (!matches[0] || !contractCasePassed(matches[0]))
        missing.push(`${project}/${role.id}/route crawl`);
    }
    const money = tests.filter(
      (test) =>
        test.projectName === project &&
        test.suitePath.at(-1) === "customer payment" &&
        test.specTitle === "money flow",
    );
    if (money.length > 1) missing.push(`duplicate ${project}/money flow`);
    else if (!money[0] || !contractCasePassed(money[0])) missing.push(`${project}/money flow`);
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
  const stats = report.stats;
  if (
    !stats ||
    ![stats.expected, stats.unexpected, stats.skipped, stats.flaky].every(
      (count) => Number.isSafeInteger(count) && count! >= 0,
    )
  ) {
    return { ok: false, detail: "report lacks complete Playwright test stats" };
  }
  if (stats.unexpected || stats.skipped || stats.flaky || stats.expected !== tests.length) {
    return { ok: false, detail: "Playwright stats contain unexpected, skipped, or flaky tests" };
  }
  const problems = contractCaseProblems(tests);
  if (problems.length > 0) {
    return { ok: false, detail: `missing successful contract cases: ${problems.join(", ")}` };
  }
  const requiredCases = MONKEY_PROJECTS.length * (MONKEY_ROLES.length + 1);
  if (tests.length !== requiredCases) {
    return {
      ok: false,
      detail: `report has extra or missing cases (${tests.length}/${requiredCases})`,
    };
  }
  const failed = tests.filter((test) => !contractCasePassed(test));
  if (failed.length > 0) {
    return { ok: false, detail: `${failed.length} unexpected or failing Playwright test(s)` };
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
    const states = new Map<string, string>();
    for (const role of MONKEY_ROLES) {
      if (!role.storageStateEnv || !role.defaultStorageState) continue;
      const statePath = resolve(root, env[role.storageStateEnv] ?? role.defaultStorageState);
      if (!existsSync(statePath)) continue;
      const content = readFileSync(statePath).toString("base64");
      const otherRole = states.get(content);
      if (otherRole) {
        throw new Error(`Auth storage state for ${role.id} is shared with ${otherRole}.`);
      }
      states.set(content, role.id);
    }
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
