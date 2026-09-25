import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseInstallCommand } from "./install-gate.js";
import { auditAllowScripts } from "./check-security.js";

// CodeQL js/redos alerts 87-89: each regex had a token alternative that could split the same
// characters more than one way (`\S*=\S+` on `a==b`, or a `[-+]` separator that the following
// class also admits), so a failing match backtracked exponentially. Inputs are the shapes
// CodeQL named; the bound is generous so only exponential blow-up fails it.
function timed(fn: () => void): number {
  const t0 = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

describe("CodeQL ReDoS regressions", () => {
  it("runner-flag scan stays linear on repeated `a==b` tokens (alert 88)", () => {
    const ms = timed(() => parseInstallCommand("npx " + "a==b ".repeat(40) + "!"));
    assert.ok(ms < 500, `took ${ms.toFixed(0)}ms`);
  });

  it("fetch-to-shell scan stays linear on repeated `a==b` env tokens (alert 89)", () => {
    const cmd = "curl https://example.com/x | sudo " + "a==b ".repeat(40) + "!";
    const ms = timed(() => parseInstallCommand(cmd));
    assert.ok(ms < 500, `took ${ms.toFixed(0)}ms`);
  });

  it("exact-version check stays linear on a long `--` run (alert 87)", () => {
    const key = "pkg@0.0.0+" + "--".repeat(40) + "!";
    const ms = timed(() => auditAllowScripts({ [key]: true }, new Set(["pkg"])));
    assert.ok(ms < 500, `took ${ms.toFixed(0)}ms`);
  });

  it("exact-version check still accepts pinned forms and rejects ranges", () => {
    const declared = new Set(["a", "b", "c", "d"]);
    const r = auditAllowScripts(
      { "a@1.2.3": true, "b@1.2.3-rc.1": true, "c@1.2.3+build.5": true, "d@^1.2.3": true },
      declared,
    );
    assert.deepEqual(r.pinned.sort(), ["a@1.2.3", "b@1.2.3-rc.1", "c@1.2.3+build.5"]);
    assert.deepEqual(r.unpinned, ["d@^1.2.3"]);
  });
});
