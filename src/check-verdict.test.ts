import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeCheckVerdict, type VerdictInputs } from "./check-verdict.js";
import type { SecurityCheckResult } from "./check-security.js";

// A fully-green fixture; each test overrides one dimension to isolate its effect.
function green(): VerdictInputs {
  return {
    tools: [{ ok: true }],
    services: [{ authenticated: true }],
    secrets: [{ available: true }],
    skills: [{ required: true, installed: true }],
    hooks: [{ installed: true, upToDate: true }],
    security: [{ category: "dependency", name: "npm audit", status: "pass", detail: "" }],
    tests: [{ status: "pass" }],
    locks: [{ inSync: true }],
  };
}

const sec = (r: Partial<SecurityCheckResult>): SecurityCheckResult => ({
  category: "dependency",
  name: "x",
  status: "pass",
  detail: "",
  ...r,
});

describe("computeCheckVerdict", () => {
  it("all-green fixture is ok with no failed dimensions", () => {
    const v = computeCheckVerdict(green());
    assert.equal(v.ok, true);
    assert.deepEqual(v.failed, []);
    assert.ok(Object.values(v.dimensions).every(Boolean));
  });

  it("each dimension can independently turn the verdict red", () => {
    const cases: [keyof VerdictInputs, VerdictInputs][] = [
      ["tools", { ...green(), tools: [{ ok: false }] }],
      ["secrets", { ...green(), secrets: [{ available: false }] }],
      ["skills", { ...green(), skills: [{ required: true, installed: false }] }],
      ["hooks", { ...green(), hooks: [{ installed: true, upToDate: false }] }],
      ["tests", { ...green(), tests: [{ status: "fail" }] }],
      ["locks", { ...green(), locks: [{ inSync: false }] }],
    ];
    for (const [dim, input] of cases) {
      const v = computeCheckVerdict(input);
      assert.equal(v.ok, false, `${dim} should fail the verdict`);
      assert.deepEqual(v.failed, [dim]);
    }
  });

  // ── The three CLI-vs-MCP divergences the old duplicate MCP rule produced ──
  // (these encode the exact false-green / false-red the shared function removes)

  it("a failing test-coverage result is RED (old MCP ignored tests → false-green)", () => {
    assert.equal(computeCheckVerdict({ ...green(), tests: [{ status: "fail" }] }).ok, false);
  });

  it("an informational (unauthenticated) service is GREEN (old MCP required authenticated → false-red)", () => {
    const v = computeCheckVerdict({
      ...green(),
      services: [{ authenticated: false, informational: true }],
    });
    assert.equal(v.dimensions.services, true);
    assert.equal(v.ok, true);
    // A genuinely-unauthenticated, non-informational service still fails.
    assert.equal(
      computeCheckVerdict({ ...green(), services: [{ authenticated: false }] }).ok,
      false,
    );
  });

  it("a security finding-warn is GREEN by default (old MCP pass||skip → false-red)", () => {
    const v = computeCheckVerdict({ ...green(), security: [sec({ status: "warn" })] });
    assert.equal(v.dimensions.security, true, "a finding-warn is not a fail by default");
    // …but --fail-on-warning turns it red.
    assert.equal(
      computeCheckVerdict(
        { ...green(), security: [sec({ status: "warn" })] },
        { failOnWarning: true },
      ).ok,
      false,
    );
  });

  it("scanner-health strict: a didNotRun warn FAILS unless lenient", () => {
    const input = { ...green(), security: [sec({ status: "warn", didNotRun: true })] };
    assert.equal(computeCheckVerdict(input).ok, false, "didNotRun fails closed by default");
    assert.equal(computeCheckVerdict(input, { lenient: true }).ok, true, "lenient downgrades it");
  });

  it("empty inputs are vacuously ok (nothing configured to fail)", () => {
    const v = computeCheckVerdict({
      tools: [],
      services: [],
      secrets: [],
      skills: [],
      hooks: [],
      security: [],
      tests: [],
      locks: [],
    });
    assert.equal(v.ok, true);
  });
});
