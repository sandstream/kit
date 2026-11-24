import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import type { JsonCheck } from "./cli-checks-shared.js";
import { runCli } from "./cli-run.test-support.js";
import { makeFixture, toml, tool } from "./commands/scan.test-support.js";
import { readSemgrepReport } from "./semgrep-report.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const clean = { results: [], errors: [], paths: { scanned: ["sample.js"] } };
const noTargets = { ...clean, paths: { scanned: [] } };
const finding = (severity: string) => ({
  check_id: "sample-rule",
  path: "sample.js",
  extra: { severity },
});

it("requires Semgrep results, errors and scanned-path arrays", () => {
  assert.equal(readSemgrepReport("").gap, "missing");
  assert.equal(readSemgrepReport('{"results":[').gap, "malformed");
  const malformed = [
    {},
    { ...clean, results: {} },
    { ...clean, errors: null },
    { ...clean, paths: {} },
  ];
  for (const report of malformed) {
    assert.equal(readSemgrepReport(JSON.stringify(report)).gap, "malformed");
  }
  assert.equal(readSemgrepReport(JSON.stringify(noTargets)).gap, "missing");
  const badPaths = { ...clean, paths: { scanned: ["sample.js", " "] } };
  assert.equal(readSemgrepReport(JSON.stringify(badPaths)).gap, "partial");
});

it("keeps duplicate results and skipped rules from establishing a clean scan", () => {
  const overwritten = '{"results":[{}],"results":[],"errors":[],"paths":{"scanned":["sample.js"]}}';
  assert.equal(readSemgrepReport(overwritten).gap, "malformed");
  const skipped = { ...clean, skipped_rules: [{ rule_id: "another-rule" }] };
  assert.equal(readSemgrepReport(JSON.stringify(skipped)).gap, "partial");
});

it("retains valid findings when other records or coverage data are invalid", () => {
  const results = [finding("ERROR"), null, finding("WARNING"), { extra: { severity: "ERROR" } }];
  const partial = readSemgrepReport(JSON.stringify({ ...clean, results }));
  assert.equal(partial.gap, "partial");
  assert.equal(partial.count, 2);
  assert.equal(partial.blocking, true);
  const malformed = readSemgrepReport(JSON.stringify({ results }));
  assert.equal(malformed.gap, "malformed");
  assert.equal(malformed.count, 2);
});

it("recognizes native severity names and excludes informational findings from the gate count", () => {
  const results = ["LOW", "INFO", "MEDIUM", "HIGH", "CRITICAL"].map(finding);
  const report = readSemgrepReport(JSON.stringify({ ...clean, results }));
  assert.equal(report.gap, undefined);
  assert.equal(report.count, 3);
  assert.equal(report.blocking, true);
});

const posix = { skip: process.platform === "win32" ? "scanner fixture uses POSIX shell" : false };

async function checkWithSemgrep(
  t: TestContext,
  report: object,
  options: { exit?: number; lenient?: true; missingConfig?: true } = {},
) {
  const fixture = makeFixture();
  t.after(() => rmTemp(fixture.dir));
  toml(fixture, "version = 1\n[memory]\ntrack_findings = false\n");
  const json = JSON.stringify(report).replaceAll("'", "'\\''");
  tool(fixture, "semgrep", `printf '%s\\n' '${json}'\nexit ${options.exit ?? 0}`);
  const flags = options.lenient ? ["--lenient"] : [];
  const run = await runCli(
    ["check", "--category", "security", "--json", "--no-auto-install", ...flags],
    fixture.dir,
    {
      PATH: fixture.bin,
      KIT_ADVISORIES: "0",
      KIT_AIRGAP: "1",
      KIT_AUDIT_ANCHOR: "0",
      KIT_NO_UPDATE_CHECK: "1",
      KIT_BUMBLEBEE: "0",
      KIT_CI_LENIENT: "",
      KIT_CI_STRICT: "",
      KIT_SEMGREP_CONFIG: options.missingConfig ? "./missing-rules.yml" : "./rules.yml",
    },
  );
  assert.ok(run.stdout.startsWith("{"), run.stdout + run.stderr);
  const out = JSON.parse(run.stdout) as { checks: JsonCheck[] };
  const row = out.checks.find((check) => check.name === "semgrep SAST");
  assert.ok(row, "missing Semgrep check row");
  return { row, exit: run.exitCode };
}

it("rejects the missing-rules report on the default CLI path", posix, async (t) => {
  const report = { ...noTargets, errors: [{ code: 2, type: "SemgrepError" }] };
  const { row, exit } = await checkWithSemgrep(t, report, { exit: 7, missingConfig: true });
  assert.equal(exit, 1);
  assert.equal(row.status, "warn");
  assert.equal(row.evidenceStatus, "unavailable");
  assert.equal(row.didNotRun, true);
  assert.equal(row.scanIncomplete, true);
  assert.match(row.detail, /exit code 7/);
});

it("accepts a successful empty Semgrep report with scanned files", posix, async (t) => {
  const { row } = await checkWithSemgrep(t, clean);
  assert.equal(row.status, "pass");
  assert.equal(row.evidenceStatus, "complete-empty");
  assert.equal(row.didNotRun, undefined);
  assert.match(row.detail, /1 scanned file/);
});

it("marks an exit-zero Semgrep report with scan errors as incomplete", posix, async (t) => {
  const report = { ...clean, errors: [{ code: 3, type: "Syntax error" }] };
  const { row } = await checkWithSemgrep(t, report);
  assert.equal(row.status, "warn");
  assert.equal(row.evidenceStatus, "partial");
  assert.equal(row.didNotRun, true);
  assert.match(row.detail, /1 scan error/);
});

it(
  "keeps a valid blocking finding from an incomplete Semgrep run in lenient mode",
  posix,
  async (t) => {
    const report = { ...noTargets, results: [null, finding("ERROR")] };
    const { row, exit } = await checkWithSemgrep(t, report, { exit: 2, lenient: true });
    assert.equal(exit, 1);
    assert.equal(row.status, "fail");
    assert.equal(row.severity, "high");
    assert.equal(row.didNotRun, true);
    assert.equal(row.hasFindings, true);
    assert.equal(row.scanIncomplete, true);
    assert.equal(row.evidenceStatus, "partial");
    assert.match(row.detail, /1 security finding.*exit code 2/);
  },
);
