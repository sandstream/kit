import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runScanners, scanHealthGate, type ScanDeps, type ScannerDef } from "./scanners.js";

const defs: ScannerDef[] = [{ id: "semgrep", bin: "semgrep", args: [], format: "sarif" }];

// The first 1 MiB of a SARIF log: valid so far, cut off before it closes.
const CUT_OFF =
  '{"runs":[{"tool":{"driver":{"name":"semgrep"}},"results":[' + '{"x":1},'.repeat(10);

function deps(truncated: boolean): ScanDeps {
  return {
    resolve: async (bin) => `/usr/bin/${bin}`,
    run: async () => ({ ok: false, stdout: CUT_OFF, truncated }),
    hasEnv: () => true,
    detect: () => true,
  };
}

describe("a scanner whose output was cut off", () => {
  it("is an error that names the buffer, not a JSON parse failure", async () => {
    const { runs } = await runScanners(deps(true), defs);
    assert.equal(runs[0]?.status, "error");
    assert.match(runs[0]?.reason ?? "", /buffer/i);
    assert.doesNotMatch(runs[0]?.reason ?? "", /not valid JSON/);
  });

  it("still fails a required-scanner gate", async () => {
    const { runs } = await runScanners(deps(true), defs);
    assert.equal(scanHealthGate(runs, { strict: false, requiredScanners: ["semgrep"] }).ok, false);
  });

  it("keeps the parse error for output that was not cut off", async () => {
    const { runs } = await runScanners(deps(false), defs);
    assert.match(runs[0]?.reason ?? "", /not valid JSON/);
  });
});
