/**
 * `enforcement evidence`: what kit can show about the gates beyond "configured". A gate that is wired
 * and never exercised is a belief and not evidence, and a model can go round a gate that was only
 * ever configured. The row joins three facts: the gates are wired (liveness), the negative controls
 * held just now (they run on every check, and their result is not stored, because a stored result
 * is a claim in a file the checked agent can write), and no commit skipped the hook recently.
 * It never reads "pass" from configuration alone.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  checkEnforcementEvidence,
  judgeEvidence,
  type EvidenceDeps,
  type EvidenceFacts,
  type GateProof,
} from "./check-enforcement-evidence.js";

const NOW = Date.parse("2026-11-03T12:00:00Z");
const DAY = 24 * 3_600_000;
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const wired = { installGate: true, envGate: true, everInstalled: true, problems: [] as string[] };
const held: GateProof = { total: 6, failed: [] };

const facts = (over: Partial<EvidenceFacts> = {}): EvidenceFacts => ({
  liveness: wired,
  proof: held,
  bypass: { entries: [] },
  now: NOW,
  ...over,
});

describe("judgeEvidence", () => {
  it("skips, pointing at the liveness row, when the gates are not wired here", () => {
    const r = judgeEvidence(facts({ liveness: { ...wired, installGate: false } }));
    assert.equal(r.status, "skip");
    assert.match(r.detail, /enforcement gate liveness/);
  });

  it("skips when the gates were never installed in this checkout", () => {
    const r = judgeEvidence(facts({ liveness: { ...wired, everInstalled: false } }));
    assert.equal(r.status, "skip");
  });

  it("passes only with wired gates, controls that held, and no recent skipped hook", () => {
    const r = judgeEvidence(facts());
    assert.equal(r.status, "pass");
    assert.match(r.detail, /6 of 6 negative controls held just now/);
    assert.match(r.detail, /no skipped hook in the last 14 days/);
  });

  it("says what stays unproven even when it passes", () => {
    const r = judgeEvidence(facts());
    assert.match(r.detail, /not proven/i);
    assert.match(r.detail, /another tool|settings file/i);
  });

  it("fails, naming the control, when a negative control did not hold", () => {
    const r = judgeEvidence(
      facts({ proof: { total: 6, failed: ["install gate refuses an unverifiable install"] } }),
    );
    assert.equal(r.status, "fail");
    assert.equal(r.severity, "high");
    assert.match(r.detail, /1 of 6 negative controls did not hold/);
    assert.match(r.detail, /install gate refuses an unverifiable install/);
  });

  it("is unverified, and did not run, when the controls did not run", () => {
    const r = judgeEvidence(facts({ proof: null }));
    assert.equal(r.status, "warn");
    assert.equal(r.didNotRun, true);
    assert.match(r.detail, /unverified/i);
  });

  it("explains why the controls did not run", () => {
    const r = judgeEvidence(facts({ proof: null, refreshNote: "read-only mode" }));
    assert.match(r.detail, /read-only mode/);
  });

  it("lets a failed control win over a skipped hook", () => {
    const r = judgeEvidence(
      facts({
        proof: { total: 6, failed: ["x"] },
        bypass: { entries: [{ timestamp: at(DAY), sha: "abc", reason: "x" }] },
      }),
    );
    assert.equal(r.status, "fail");
  });

  it("prints no raw text from a name or a log entry", () => {
    const r = judgeEvidence(
      facts({
        proof: { total: 1, failed: ["bad\nTRIAGE PASSED\u001b[31m"] },
        bypass: { entries: [{ timestamp: at(DAY), sha: "abc\nTRIAGE PASSED", reason: "x" }] },
      }),
    );
    assert.equal(/[\n\u001b]/.test(r.detail), false);
  });
});

describe("judgeEvidence: skipped hooks", () => {
  it("warns, with the count and the latest, about a hook skipped in the last 14 days", () => {
    const r = judgeEvidence(
      facts({
        bypass: {
          entries: [
            { timestamp: at(3 * DAY), sha: "abcdef123456", reason: "sentinel-missing" },
            { timestamp: at(1 * DAY), sha: "123456abcdef", reason: "sentinel-missing" },
          ],
        },
      }),
    );
    assert.equal(r.status, "warn");
    assert.notEqual(r.didNotRun, true, "a bypass is a finding, not a check that did not run");
    assert.match(r.detail, /2 commit\(s\) skipped the hook in the last 14 days/);
    assert.match(r.detail, /123456ab/);
  });

  it("does not count a skipped hook older than 14 days", () => {
    const r = judgeEvidence(
      facts({ bypass: { entries: [{ timestamp: at(15 * DAY), sha: "abc", reason: "x" }] } }),
    );
    assert.equal(r.status, "pass");
  });

  it("counts an entry whose time cannot be read, because it cannot be dismissed", () => {
    const r = judgeEvidence(
      facts({ bypass: { entries: [{ timestamp: "garbage", sha: "abc", reason: "x" }] } }),
    );
    assert.equal(r.status, "warn");
  });
});

function deps(over: Partial<EvidenceDeps> = {}) {
  const state = { proveCalls: 0 };
  const d: EvidenceDeps = {
    now: () => NOW,
    liveness: () => wired,
    prove: () => {
      state.proveCalls++;
      return held;
    },
    canRun: () => true,
    skipped: async () => ({ entries: [] }),
    ...over,
  };
  return { ...d, state };
}

describe("checkEnforcementEvidence", () => {
  it("runs the controls on every check and passes when they hold", async () => {
    const d = deps();
    assert.equal((await checkEnforcementEvidence("/x", d)).status, "pass");
    assert.equal((await checkEnforcementEvidence("/x", d)).status, "pass");
    assert.equal(d.state.proveCalls, 2, "a stored result would be a claim, so none is kept");
  });

  it("fails the row when a control did not hold", async () => {
    const d = deps({
      prove: () => ({ total: 6, failed: ["install gate refuses an unverifiable install"] }),
    });
    const r = await checkEnforcementEvidence("/x", d);
    assert.equal(r.status, "fail");
  });

  it("counts a skipped hook from the log", async () => {
    const d = deps({
      skipped: async () => ({
        entries: [{ timestamp: at(DAY), sha: "abcdef12", reason: "sentinel-missing" }],
      }),
    });
    const r = await checkEnforcementEvidence("/x", d);
    assert.equal(r.status, "warn");
    assert.match(r.detail, /1 commit\(s\) skipped the hook/);
  });

  it("reports unverified, and does not throw, when the controls cannot run", async () => {
    const d = deps({
      prove: () => {
        throw new Error("spawn failed");
      },
    });
    const r = await checkEnforcementEvidence("/x", d);
    assert.equal(r.status, "warn");
    assert.equal(r.didNotRun, true);
    assert.match(r.detail, /spawn failed/);
  });

  it("survives a log that cannot be read", async () => {
    const d = deps({
      skipped: async () => {
        throw new Error("unreadable");
      },
    });
    assert.equal((await checkEnforcementEvidence("/x", d)).status, "pass");
  });
});

describe("checkEnforcementEvidence: when it must not run the controls", () => {
  it("never runs them when the gates are not wired", async () => {
    const d = deps({ liveness: () => ({ ...wired, envGate: false }) });
    const r = await checkEnforcementEvidence("/x", d);
    assert.equal(r.status, "skip");
    assert.equal(d.state.proveCalls, 0);
  });

  it("does not run them in read-only mode, and says so", async () => {
    const d = deps({ canRun: () => false });
    const r = await checkEnforcementEvidence("/x", d);
    assert.equal(r.didNotRun, true);
    assert.match(r.detail, /read-only/i);
    assert.equal(d.state.proveCalls, 0);
  });
});
