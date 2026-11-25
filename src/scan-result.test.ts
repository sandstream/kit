import assert from "node:assert/strict";
import { it } from "node:test";
import { SCANNERS, runScanners, scanHealthGate, type ScanDeps } from "./scanners.js";

const repoScan = (id: string, result: Awaited<ReturnType<ScanDeps["run"]>>) => {
  const scanner = SCANNERS.find((entry) => entry.id === id);
  assert.ok(scanner);
  return runScanners(
    {
      resolve: async () => "/fixture/scanner",
      run: async () => result,
      hasEnv: () => true,
      detect: () => true,
    },
    [scanner],
  );
};

const reportWith = (results: unknown[]) =>
  JSON.stringify({
    version: "2.1.0",
    runs: [{ tool: { driver: { name: "fixture" } }, results }],
  });
const report = reportWith([
  { ruleId: "sample", level: "warning", message: { text: "Example finding" } },
]);

it("retains findings but blocks required coverage after a scanner failure or pause", async () => {
  for (const expected of [
    { status: "error", result: { exitCode: 2 } },
    { status: "error", result: { exitCode: 1, noNumericExitStatus: true as const } },
    { status: "timed-out", result: { timedOut: true } },
    { status: "error", result: { truncated: true } },
  ]) {
    const { merged, runs } = await repoScan("snyk", {
      ok: false,
      stdout: report,
      ...expected.result,
    });
    assert.equal(merged.length, 1);
    assert.equal(runs[0].status, expected.status);
    assert.equal(runs[0].reportGap, "partial");
    assert.equal(scanHealthGate(runs, { requiredScanners: ["snyk"] }).ok, false);
  }
});

it("accepts a documented finding exit when a completed report carries findings", async () => {
  const { merged, runs } = await repoScan("snyk", {
    ok: false,
    stdout: report,
    exitCode: 1,
    evidence: { status: "complete", packageCount: 1 },
  });
  assert.equal(merged.length, 1);
  assert.equal(runs[0].status, "ran");
  assert.equal(scanHealthGate(runs, { requiredScanners: ["snyk"] }).ok, true);
});

it("rejects a finding exit without findings", async () => {
  const stdout = reportWith([]);
  const { runs } = await repoScan("snyk", { ok: false, stdout, exitCode: 1 });
  assert.equal(runs[0].status, "error");
  assert.match(runs[0].reason ?? "", /exit code 1/);
});

it("treats an OSV no-target code with a JSON error as a failed scan", async () => {
  const { runs } = await repoScan("osv-scanner", {
    ok: false,
    stdout: '{"error":"fixture manifest could not be read"}',
    exitCode: 128,
  });
  assert.equal(runs[0].status, "error");
  assert.equal(runs[0].reportGap, "malformed");
  assert.equal(scanHealthGate(runs, { strict: true }).ok, false);
});

it("treats a Socket authentication refusal as a scanner failure as well as a finding", async () => {
  const { runs, merged } = await repoScan("socket", {
    ok: false,
    stdout: '{"data":{"code":403}}',
    exitCode: 1,
  });
  assert.equal(runs[0].status, "error");
  assert.match(runs[0].reason ?? "", /HTTP 403/);
  assert.equal(merged.length, 1);
  assert.equal(scanHealthGate(runs, { requiredScanners: ["socket"] }).ok, false);
});

it("does not merge a SARIF result whose kind says it passed", async () => {
  const { merged, runs } = await repoScan("snyk", {
    ok: true,
    stdout: reportWith([
      { ruleId: "checked", kind: "pass", level: "none", message: { text: "ok" } },
      { ruleId: "sample", kind: "fail", level: "warning", message: { text: "Example finding" } },
    ]),
    exitCode: 0,
    evidence: { status: "complete", packageCount: 1 },
  });
  assert.deepEqual(
    merged.map((f) => f.name),
    ["fixture: sample"],
  );
  assert.equal(runs[0].status, "ran");
});
