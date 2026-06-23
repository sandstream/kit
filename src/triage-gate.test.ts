import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { triageTargetFor, gateInstall, CORE_RUNTIMES, type GateDeps } from "./triage-gate.js";
import type { TriageResult, TriageType } from "./triage.js";

const triageStub = (passed: boolean, output = ""): GateDeps => ({
  runTriage: async (type: TriageType, target: string): Promise<TriageResult> => ({
    type,
    target,
    passed,
    output: output || (passed ? "TRIAGE PASSED" : "TRIAGE WARNING: 2 critical issues"),
  }),
});

describe("triage-gate — ref → triage target mapping", () => {
  it("aqua ref → repo triage on the github repo", () => {
    assert.deepEqual(triageTargetFor("aqua:aquasecurity/trivy"), {
      kind: "triage",
      type: "repo",
      target: "https://github.com/aquasecurity/trivy",
    });
  });

  it("npm ref → npm triage on the package", () => {
    assert.deepEqual(triageTargetFor("npm:@socketsecurity/cli"), {
      kind: "triage",
      type: "npm",
      target: "@socketsecurity/cli",
    });
  });

  it("pipx/pip ref → pip triage", () => {
    assert.deepEqual(triageTargetFor("pipx:semgrep"), {
      kind: "triage",
      type: "pip",
      target: "semgrep",
    });
    assert.deepEqual(triageTargetFor("pip:semgrep"), {
      kind: "triage",
      type: "pip",
      target: "semgrep",
    });
  });

  it("ubi/go refs carrying owner/repo → repo triage", () => {
    assert.deepEqual(triageTargetFor("ubi:google/osv-scanner"), {
      kind: "triage",
      type: "repo",
      target: "https://github.com/google/osv-scanner",
    });
    assert.deepEqual(triageTargetFor("go:github.com/google/osv-scanner/cmd/osv-scanner"), {
      kind: "triage",
      type: "repo",
      target: "https://github.com/google/osv-scanner",
    });
  });

  it("bare core runtime → trusted runtime (not triaged)", () => {
    assert.deepEqual(triageTargetFor("node"), { kind: "runtime" });
    assert.deepEqual(triageTargetFor("pnpm"), { kind: "runtime" });
    for (const r of CORE_RUNTIMES) assert.equal(triageTargetFor(r).kind, "runtime");
  });

  it("unknown bare name → untriageable (no triage path)", () => {
    assert.deepEqual(triageTargetFor("some-random-tool"), {
      kind: "untriageable",
      ref: "some-random-tool",
    });
  });

  it("scheme without a derivable repo → untriageable", () => {
    assert.equal(triageTargetFor("cargo:").kind, "untriageable");
  });
});

describe("triage-gate — watertight gate (fail-closed)", () => {
  it("core runtime passes without triage", async () => {
    const v = await gateInstall("node", triageStub(false)); // stub would fail, but runtime skips triage
    assert.equal(v.decision, "pass");
  });

  it("third-party tool with triage PASS → pass", async () => {
    const v = await gateInstall("aqua:aquasecurity/trivy", triageStub(true));
    assert.equal(v.decision, "pass");
    assert.equal(v.triageType, "repo");
  });

  it("triage non-pass (WARN/FAIL/offline) → blocked", async () => {
    const v = await gateInstall(
      "aqua:aquasecurity/trivy",
      triageStub(false, "TRIAGE WARNING: typosquat risk"),
    );
    assert.equal(v.decision, "blocked");
    assert.match(v.reason, /did not pass/);
    assert.match(v.reason, /typosquat/);
  });

  it("unmappable ref → blocked (cannot verify)", async () => {
    const v = await gateInstall("some-random-tool", triageStub(true));
    assert.equal(v.decision, "blocked");
    assert.match(v.reason, /cannot verify|no triage path/);
  });
});
