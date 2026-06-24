import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyGuardDog } from "./guarddog.js";

const pkg = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ package: "x", issues: 0, errors: {}, results: {}, ...over });

describe("classifyGuardDog", () => {
  it("passes ONLY on a complete scan with zero indicators", () => {
    const r = classifyGuardDog(pkg({ issues: 0, errors: {} }));
    assert.equal(r.status, "pass");
  });

  it("fails on malware indicators (issues > 0)", () => {
    const r = classifyGuardDog(pkg({ issues: 3 }));
    assert.equal(r.status, "fail");
    assert.equal(r.severity, "critical");
    assert.match(r.detail, /3 malware indicator/);
  });

  it("FAIL CLOSED: zero issues but a rule errored (e.g. semgrep missing) → warn, not pass", () => {
    // the real GuardDog shape when semgrep isn't found
    const r = classifyGuardDog(
      pkg({ issues: 0, errors: { "rules-all": "unable to find semgrep binary" } }),
    );
    assert.equal(r.status, "warn");
    assert.match(r.detail, /INCOMPLETE|UNVERIFIED/);
  });

  it("real indicators still fail even if some rules errored", () => {
    const r = classifyGuardDog(pkg({ issues: 2, errors: { "rules-all": "boom" } }));
    assert.equal(r.status, "fail");
  });

  it("handles an array (verify mode) — sums issues across packages", () => {
    const arr = JSON.stringify([
      { package: "a", issues: 0, errors: {} },
      { package: "b", issues: 1, errors: {} },
    ]);
    const r = classifyGuardDog(arr);
    assert.equal(r.status, "fail");
    assert.match(r.detail, /1 malware indicator.* 2 package/);
  });

  it("warns (not pass) on unparseable output", () => {
    const r = classifyGuardDog("not json at all");
    assert.equal(r.status, "warn");
    assert.match(r.detail, /UNVERIFIED/);
  });

  it("warns on empty results array", () => {
    assert.equal(classifyGuardDog("[]").status, "warn");
  });
});
