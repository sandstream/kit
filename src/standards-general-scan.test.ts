import assert from "node:assert/strict";
import { it } from "node:test";
import { runToolHealthFixture } from "./standards-tool-health.test-support.js";

const safeSource = "def safe():\n    return 1\n";
const safeCsv = '2,1,7,0,2,"safe@1-2@main.py",main.py,safe,"safe()",1,2\n';
const branchySource =
  safeSource +
  "\ndef branchy(value):\n" +
  Array.from({ length: 15 }, (_, n) => `    if value == ${n}: return ${n}\n`).join("") +
  "    return -1\n";
const branchyCsv = '17,16,150,1,17,"branchy@4-20@main.py",main.py,branchy,"branchy(value)",4,20\n';

it("accepts complete valid scanner reports for a nonempty project", () => {
  const { gate } = runToolHealthFixture({ source: safeSource, csv: safeCsv, exitCode: 0 });
  assert.equal(gate.ok, true);
  assert.equal(gate.checks.length, 3);
  assert.ok(gate.checks.every((check) => check.status === "pass" && !check.didNotRun));
  assert.equal(gate.summary.score, "3/3");
});

it("retains threshold findings from a complete zero-exit lizard CSV report", () => {
  const { gate } = runToolHealthFixture({
    source: branchySource,
    csv: safeCsv + branchyCsv,
    exitCode: 0,
  });
  assert.equal(gate.ok, false);
  assert.equal(gate.summary.setupGaps, 0);
  assert.equal(gate.summary.findings, 1);
  const complexity = gate.checks.find((check) => check.name.startsWith("complexity"));
  assert.equal(complexity?.status, "fail");
  assert.match(complexity?.files?.join("\n") ?? "", /branchy/);
});

it("accepts successful empty reports for a genuinely empty project", () => {
  const { gate } = runToolHealthFixture({ source: "", csv: "", exitCode: 0 });
  assert.equal(gate.ok, true);
  assert.equal(gate.checks.length, 3);
  assert.ok(gate.checks.every((check) => check.status === "pass" && !check.didNotRun));
  assert.equal(gate.summary.setupGaps, 0);
});

it("fails the enforced gate when lizard exits 2 after emitting one clean CSV row", (t) => {
  const { gate, toolCalls } = runToolHealthFixture({
    source: branchySource,
    csv: safeCsv,
    exitCode: 2,
  });
  t.diagnostic(JSON.stringify({ gate, toolCalls }));
  assert.equal(gate.ok, false, "partial CSV from a crashed scanner must not certify the project");
  const complexity = gate.checks.find((check) => check.name.startsWith("complexity"));
  assert.equal(complexity?.status, "fail");
  assert.equal(complexity?.didNotRun, true);
  assert.equal(gate.summary.setupGaps, 1);
  assert.equal(gate.summary.findings, 0);
});

it("refuses partial CSV and an exit-1 traceback under lizard report mode", (t) => {
  const { gate, toolCalls } = runToolHealthFixture({
    source: branchySource,
    csv: safeCsv,
    exitCode: 1,
  });
  t.diagnostic(JSON.stringify({ gate, toolCalls }));
  assert.equal(gate.ok, false, "exit 1 in report mode must not be treated as threshold findings");
  const complexity = gate.checks.find((check) => check.name.startsWith("complexity"));
  assert.equal(complexity?.status, "fail");
  assert.equal(complexity?.didNotRun, true);
  assert.match(complexity?.detail ?? "", /lizard.*(complete|report)/i);
  assert.doesNotMatch(complexity?.detail ?? "", /not installed/i);
  assert.equal(gate.summary.setupGaps, 1);
  assert.equal(gate.summary.findings, 0);
});

it("rejects malformed JSON written by a successful jscpd process", (t) => {
  const jscpdReport = '{"statistics":';
  const { gate, toolCalls } = runToolHealthFixture({
    source: safeSource,
    csv: safeCsv,
    exitCode: 0,
    jscpdReport,
  });
  t.diagnostic(JSON.stringify({ gate, toolCalls, jscpdReport }));
  assert.equal(gate.ok, false, "malformed jscpd JSON must not certify the project as clean");
  const duplication = gate.checks.find((check) => check.name.startsWith("duplication"));
  assert.equal(duplication?.status, "fail");
  assert.equal(duplication?.didNotRun, true);
  assert.equal(gate.summary.setupGaps, 1);
  assert.equal(gate.summary.findings, 0);
  assert.equal(gate.summary.passed, 2);
});

it("rejects an invalid line count in JSON emitted by a successful scc process", (t) => {
  const sccReport = '[{"Name":"Python","Files":[{"Location":"main.py","Lines":"invalid"}]}]';
  const { gate, toolCalls } = runToolHealthFixture({
    source: safeSource,
    csv: safeCsv,
    exitCode: 0,
    sccReport,
  });
  t.diagnostic(JSON.stringify({ gate, toolCalls, sccReport }));
  assert.equal(gate.ok, false, "invalid scc measurements must not certify the project as clean");
  const size = gate.checks.find((check) => check.name.startsWith("file size"));
  assert.equal(size?.status, "fail");
  assert.equal(size?.didNotRun, true);
  assert.equal(gate.summary.setupGaps, 1);
  assert.equal(gate.summary.findings, 0);
  assert.equal(gate.summary.passed, 2);
});

it("preserves the accepted baseline when a scanner report cannot be verified", () => {
  const result = runToolHealthFixture({
    source: safeSource,
    csv: safeCsv,
    exitCode: 0,
    jscpdReport: "not json",
    freeze: true,
  });
  assert.equal(result.gate.ok, false);
  assert.equal(
    result.freezeAccepted,
    false,
    "incomplete analysis must not replace accepted evidence",
  );
  assert.equal(result.baselineAfter, result.baselineBefore);
});

it("can freeze measured findings while preserving the distinction from scanner failure", () => {
  const result = runToolHealthFixture({
    source: branchySource,
    csv: safeCsv + branchyCsv,
    exitCode: 0,
    freeze: true,
  });
  assert.equal(result.gate.ok, false);
  assert.equal(result.gate.summary.setupGaps, 0);
  assert.equal(result.freezeAccepted, true);
  const baseline = JSON.parse(result.baselineAfter!);
  assert.deepEqual(baseline.categories.standards.complexity, ["main.py:branchy"]);
});
