import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SCAN_TIMEOUT_MS, abortedRun, isFailedRun } from "./scan-abort.js";
import {
  SCANNERS,
  runScanners,
  scanHealthGate,
  type ScanDeps,
  type ScannerDef,
} from "./scanners.js";

const osv = SCANNERS.find((s) => s.id === "osv-scanner") as ScannerDef;
const WARNING = "Warning: enricher transitivedependency/pomxml may be risky";

describe("abortedRun", () => {
  it("names the time limit for a killed run, not the stderr warning", () => {
    const run = abortedRun({ id: "osv-scanner", timeoutMs: 600_000 }, { timedOut: true });
    assert.equal(run?.status, "timed-out");
    assert.match(run?.reason ?? "", /timed out after 600 s/);
    assert.match(run?.reason ?? "", /not a scanner crash/);
  });

  it("uses the default limit when the scanner sets none", () => {
    const run = abortedRun({ id: "trivy" }, { timedOut: true });
    assert.match(run?.reason ?? "", new RegExp(`${DEFAULT_SCAN_TIMEOUT_MS / 1000} s`));
  });

  it("names the buffer for a cut-off report", () => {
    const run = abortedRun({ id: "semgrep" }, { truncated: true });
    assert.match(run?.reason ?? "", /buffer limit/);
  });

  it("says nothing about a run that was neither killed nor cut off", () => {
    assert.equal(abortedRun({ id: "trivy" }, {}), undefined);
  });
});

describe("a scanner that ran out of time", () => {
  const deps = (timedOut: boolean): ScanDeps => ({
    resolve: async (bin) => `/usr/bin/${bin}`,
    run: async () => ({ ok: false, stdout: "", stderr: WARNING, timedOut }),
    hasEnv: () => true,
    detect: () => true,
  });

  it("reports the timeout even though stderr holds a harmless warning", async () => {
    const { runs } = await runScanners(deps(true), [osv]);
    assert.equal(runs[0]?.status, "timed-out");
    assert.match(runs[0]?.reason ?? "", /timed out/);
    assert.doesNotMatch(runs[0]?.reason ?? "", /may be risky/);
  });

  it("still shows the stderr line when the run was not killed", async () => {
    const { runs } = await runScanners(deps(false), [osv]);
    assert.match(runs[0]?.reason ?? "", /may be risky/);
  });
});

describe("osv-scanner time limit", () => {
  it("allows a network-bound run at least ten minutes", () => {
    assert.ok((osv.timeoutMs ?? 0) >= 600_000);
  });
});

describe("the timed-out status", () => {
  const timedOut = [{ id: "osv-scanner", status: "timed-out" as const, findings: 0 }];

  it("is its own status, and a cut-off report stays an error", () => {
    assert.equal(abortedRun({ id: "s" }, { timedOut: true })?.status, "timed-out");
    assert.equal(abortedRun({ id: "s" }, { truncated: true })?.status, "error");
  });

  it("is a failed run for the report, like an error", () => {
    assert.equal(isFailedRun("timed-out"), true);
    assert.equal(isFailedRun("error"), true);
    for (const ok of ["ran", "not-applicable", "not-installed", "no-token"] as const) {
      assert.equal(isFailedRun(ok), false, ok);
    }
  });

  it("is a warning by default, so existing green CIs keep passing", () => {
    const gate = scanHealthGate(timedOut);
    assert.equal(gate.ok, true);
    assert.match(gate.warnings[0] ?? "", /osv-scanner did not run \(timed-out\)/);
  });

  it("fails a required scanner and a strict run, never green", () => {
    assert.equal(scanHealthGate(timedOut, { requiredScanners: ["osv-scanner"] }).ok, false);
    assert.equal(scanHealthGate(timedOut, { strict: true }).ok, false);
  });
});
