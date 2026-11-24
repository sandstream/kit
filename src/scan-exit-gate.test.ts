import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { socketReport } from "./commands/scan.test-support.js";
import { exitGateFinding, readSocketPolicy } from "./scan-exit-gate.js";
import { runScanners, type ScanDeps, type ScannerDef } from "./scanners.js";

const socket = { id: "socket", needsToken: "SOCKET_SECURITY_API_TOKEN" };
const json = (code: number) => JSON.stringify({ ok: false, data: { code, message: "refused" } });

describe("exitGateFinding", () => {
  it("says the scan could not run when the API refuses the token", () => {
    for (const code of [401, 403]) {
      const f = exitGateFinding(socket, { ok: false, stdout: json(code), stderr: "" }, false);
      assert.equal(f.status, "fail");
      assert.equal(f.severity, "high");
      assert.match(f.name, /could not run/);
      assert.match(f.detail, new RegExp(String(code)));
      assert.match(f.detail, /SOCKET_SECURITY_API_TOKEN/);
      assert.doesNotMatch(f.detail, /policy issues found/);
    }
  });

  it("reads a refused token from the error text when there is no JSON", () => {
    const stderr = "Socket API POST request failed (401): Unauthorized";
    const f = exitGateFinding(socket, { ok: false, stdout: "", stderr }, false);
    assert.match(f.name, /could not run/);
  });

  it("does not claim what was found when the cause is unknown", () => {
    const f = exitGateFinding(socket, { ok: false, stdout: "not json", stderr: "" }, false);
    assert.equal(f.status, "fail");
    assert.equal(f.severity, "high");
    assert.match(f.detail, /exited non-zero/);
    assert.match(f.detail, /did not finish/);
    assert.doesNotMatch(f.name, /could not run/);
  });

  it("treats another API error code as an unknown cause, not as a refused token", () => {
    const f = exitGateFinding(socket, { ok: false, stdout: json(500), stderr: "" }, false);
    assert.doesNotMatch(f.name, /could not run/);
  });
});

describe("readSocketPolicy", () => {
  it("requires the CI scan identity, options and license coverage", () => {
    const native = socketReport(true);
    assert.equal(readSocketPolicy(JSON.stringify(native))?.verdict, true);
    for (const incomplete of [
      { scanId: "" },
      { orgSlug: " " },
      { includeLicensePolicy: false },
      { options: { fold: "package", reportLevel: "error" } },
      { options: { fold: "version", reportLevel: "warn" } },
      { alerts: [] },
      { alerts: { npm: { "fixture-dependency": {} } } },
    ]) {
      assert.deepEqual(
        readSocketPolicy(JSON.stringify({ ...native, data: { ...native.data, ...incomplete } })),
        { reportedViolation: false },
      );
    }
  });

  it("preserves a policy violation when the report contradicts it or has damaged records", () => {
    const native = socketReport(false);
    assert.deepEqual(readSocketPolicy(JSON.stringify(native)), {
      verdict: false,
      reportedViolation: true,
    });
    for (const incomplete of [
      { healthy: true },
      { alerts: { ...native.data.alerts, malformed: [] } },
      { alerts: {} },
    ]) {
      assert.deepEqual(
        readSocketPolicy(JSON.stringify({ ...native, data: { ...native.data, ...incomplete } })),
        { reportedViolation: true },
      );
    }
  });
});

describe("runScanners with an exit-gated scanner", () => {
  const defs: ScannerDef[] = [
    { id: "socket", bin: "socket", args: ["ci"], format: "sarif", exitGate: true },
  ];

  it("keeps a refused token a high finding, never a green run", async () => {
    const deps: ScanDeps = {
      resolve: async (bin) => `/usr/bin/${bin}`,
      run: async () => ({ ok: false, stdout: json(401), stderr: "" }),
      hasEnv: () => true,
      detect: () => true,
    };
    const { merged, runs } = await runScanners(deps, defs);
    assert.equal(runs[0]?.findings, 1);
    assert.equal(merged[0]?.severity, "high");
    assert.match(merged[0]?.detail ?? "", /401/);
  });
});
