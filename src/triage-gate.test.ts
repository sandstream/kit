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

  // ─── the refusal has to name the cause, not restate the target ──────────────────────
  //
  // `triage.py` opens with `Triage: <type> <target>`, so picking the first non-empty line
  // restated the header the caller already prints and dropped the reason. A blocked install
  // read `triage did not pass (repo X): Triage: repo X` — a tautology — while
  // "set GITHUB_TOKEN and retry" sat two lines below. Measured on kit's own repo: `kit install`
  // refused BOTH declared scanners that way, so the remediation `kit check` suggests
  // ("run kit install") was a dead end that never said what to remedy.

  const REAL_OUTPUT = [
    "Triage: repo https://github.com/aquasecurity/trivy",
    "--------------------------------------------------",
    "  x CRITICAL: GitHub API rate-limited -- cannot verify (set GITHUB_TOKEN and retry)",
    "",
    "Health score: 55/100",
    "TRIAGE FAILED",
  ].join("\n");

  it("names the CRITICAL cause, not the header it was handed", async () => {
    const v = await gateInstall("aqua:aquasecurity/trivy", triageStub(false, REAL_OUTPUT));
    assert.equal(v.decision, "blocked");
    assert.match(v.reason, /set GITHUB_TOKEN and retry/);
    // The regression: the header must not be what the operator is shown as the reason.
    assert.doesNotMatch(v.reason, /: Triage: repo/);
  });

  it("falls back to the WARNING line when there is no CRITICAL", async () => {
    const v = await gateInstall(
      "aqua:aquasecurity/trivy",
      triageStub(false, "Triage: repo x/y\n----\n  ! WARNING: single maintainer\nTRIAGE FAILED"),
    );
    assert.match(v.reason, /single maintainer/);
    assert.doesNotMatch(v.reason, /: Triage: repo/);
  });

  it("still returns something when the output is only a header", async () => {
    // Must never return less than the old behaviour did.
    const v = await gateInstall("aqua:aquasecurity/trivy", triageStub(false, "Triage: repo x/y"));
    assert.equal(v.decision, "blocked");
    assert.match(v.reason, /did not pass/);
    assert.ok(v.reason.length > 0);
  });

  it("unmappable ref → blocked (cannot verify)", async () => {
    const v = await gateInstall("some-random-tool", triageStub(true));
    assert.equal(v.decision, "blocked");
    assert.match(v.reason, /cannot verify|no triage path/);
  });
});
