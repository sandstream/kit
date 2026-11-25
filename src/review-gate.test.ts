/**
 * src/review-gate.ts: the review gate's pure decision, mapped onto five verdicts. How check runs
 * are read is pinned by src/agent-review-gate.test.ts on the script and held equal to it by
 * src/review-gate-parity.test.ts, so it is not repeated here.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decideGate, MAX_CHANGED_LINES, VERDICT_EXIT } from "./review-gate.js";

const green = { state: "green" as const, failed: [], total: 5 };
const base = { checks: green, protectedPaths: [], changedLines: 10, truncated: false };

describe("review gate: verdicts", () => {
  it("approves only when every gate passed, with no reason", () => {
    assert.deepEqual(decideGate(base), { verdict: "approve", reasons: [] });
  });

  it("routes a protected path, a wide module or an oversized change to the owner", () => {
    const prot = decideGate({
      ...base,
      protectedPaths: [{ path: ".github/x.yml", classes: ["github"] }],
    });
    assert.equal(prot.verdict, "owner");
    assert.match(prot.reasons[0]!.text, /protected paths \(github\).*`\.github\/x\.yml`/);
    const wide = decideGate({ ...base, widePaths: [{ path: "src/config.ts", importers: 132 }] });
    assert.equal(wide.verdict, "owner");
    assert.match(wide.reasons[0]!.text, /`src\/config\.ts` \(132 importers\)/);
    assert.equal(decideGate({ ...base, changedLines: MAX_CHANGED_LINES + 1 }).verdict, "owner");
    assert.equal(decideGate({ ...base, changedLines: MAX_CHANGED_LINES }).verdict, "approve");
  });

  it("holds on failed checks or a red main, even when the owner is also needed", () => {
    const failed = { state: "failed" as const, failed: ["CI"], total: 3 };
    const d = decideGate({ ...base, checks: failed, changedLines: MAX_CHANGED_LINES + 1 });
    assert.equal(d.verdict, "hold");
    assert.deepEqual(
      d.reasons.map((r) => r.verdict),
      ["hold", "owner"],
    );
    const red = decideGate({ ...base, main: { sha: "c".repeat(40), red: ["build-and-test"] } });
    assert.equal(red.verdict, "hold");
    assert.match(red.reasons[0]!.text, /red at `cccccccccccc` \(build-and-test failed\)/);
    assert.equal(
      decideGate({ ...base, main: { sha: "c".repeat(40), red: [] } }).verdict,
      "approve",
    );
  });

  it("waits while checks run, and never approves on a read error or a truncated list", () => {
    const pending = decideGate({ ...base, checks: { state: "pending", failed: [], total: 0 } });
    assert.equal(pending.verdict, "pending");
    assert.match(pending.reasons[0]!.text, /no check has reported/);
    assert.equal(decideGate({ ...base, truncated: true }).verdict, "incomplete");
    const unread = decideGate({
      ...base,
      checks: { state: "pending", failed: [], total: 2 },
      unread: ["x"],
    });
    assert.equal(unread.verdict, "incomplete");
  });

  it("gives each verdict its own exit code, and 0 only to approve", () => {
    const codes = Object.values(VERDICT_EXIT);
    assert.equal(new Set(codes).size, codes.length);
    assert.equal(VERDICT_EXIT.approve, 0);
    assert.ok(!codes.includes(1) && !codes.includes(2), "1 is a generic failure, 2 a usage error");
  });
});
