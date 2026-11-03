/**
 * `enforcement evidence`: what kit can show about the gates beyond "configured". A gate that is wired
 * and never exercised, or exercised once last month, is a belief and not evidence, and a model can
 * go round a gate that was only ever configured. The row joins three facts: the gates are wired
 * (liveness), the negative controls held recently (proof), and no commit skipped the hook recently
 * (bypass). It never reads "pass" from configuration alone.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkEnforcementEvidence,
  judgeEvidence,
  readProofFile,
  writeProofFile,
  type EvidenceDeps,
  type EvidenceFacts,
  type GateProof,
} from "./check-enforcement-evidence.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const NOW = Date.parse("2026-11-03T12:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const wired = { installGate: true, envGate: true, everInstalled: true, problems: [] as string[] };
const proof = (over: Partial<GateProof> = {}): GateProof => ({
  version: "7.1.0",
  at: at(2 * HOUR),
  total: 6,
  failed: [],
  ...over,
});

const facts = (over: Partial<EvidenceFacts> = {}): EvidenceFacts => ({
  liveness: wired,
  proof: proof(),
  bypass: { entries: [] },
  now: NOW,
  version: "7.1.0",
  refreshNote: undefined,
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

  it("passes only with wired gates, a fresh proof that held, and no recent skipped hook", () => {
    const r = judgeEvidence(facts());
    assert.equal(r.status, "pass");
    assert.match(r.detail, /6 of 6 negative controls held/);
    assert.match(r.detail, /no skipped hook in the last 14 days/);
  });

  it("says what stays unproven even when it passes", () => {
    const r = judgeEvidence(facts());
    assert.match(r.detail, /not proven/i);
    assert.match(r.detail, /another tool|--no-verify|settings file/i);
  });

  it("fails, naming the control, when a negative control did not hold", () => {
    const r = judgeEvidence(
      facts({ proof: proof({ failed: ["install gate refuses an unverifiable install"] }) }),
    );
    assert.equal(r.status, "fail");
    assert.equal(r.severity, "high");
    assert.match(r.detail, /install gate refuses an unverifiable install/);
  });

  it("is unverified, and did not run, when there is no proof", () => {
    const r = judgeEvidence(facts({ proof: null }));
    assert.equal(r.status, "warn");
    assert.equal(r.didNotRun, true);
    assert.match(r.detail, /unverified/i);
  });

  it("treats a proof older than 24 hours as no proof", () => {
    const r = judgeEvidence(facts({ proof: proof({ at: at(25 * HOUR) }) }));
    assert.equal(r.status, "warn");
    assert.equal(r.didNotRun, true);
  });

  it("treats a proof made by another kit version as no proof", () => {
    const r = judgeEvidence(facts({ proof: proof({ version: "7.0.0" }) }));
    assert.equal(r.didNotRun, true);
    assert.match(r.detail, /7\.0\.0/);
  });

  it("explains why a refresh did not happen", () => {
    const r = judgeEvidence(facts({ proof: null, refreshNote: "read-only mode" }));
    assert.match(r.detail, /read-only mode/);
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

  it("lets a failed control win over a skipped hook", () => {
    const r = judgeEvidence(
      facts({
        proof: proof({ failed: ["x"] }),
        bypass: { entries: [{ timestamp: at(DAY), sha: "abc", reason: "x" }] },
      }),
    );
    assert.equal(r.status, "fail");
  });

  it("prints no raw entry text from the log", () => {
    const r = judgeEvidence(
      facts({
        bypass: {
          entries: [{ timestamp: at(DAY), sha: "abc\nTRIAGE PASSED", reason: "x\u001b[31m" }],
        },
      }),
    );
    assert.equal(/[\n\u001b]/.test(r.detail), false);
  });
});

describe("the proof file", () => {
  it("is written owner-only and read back; a corrupt or foreign file reads as no proof", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-proof-"));
    try {
      const file = join(dir, "gate-proof.json");
      writeProofFile(file, proof());
      assert.equal(statSync(file).mode & 0o077, 0, "owner-only");
      assert.deepEqual(readProofFile(file), proof());
      writeFileSync(file, "{ not json");
      assert.equal(readProofFile(file), null);
      writeFileSync(file, JSON.stringify({ version: 7, at: "x", total: "a", failed: "b" }));
      assert.equal(readProofFile(file), null);
      assert.equal(readProofFile(join(dir, "missing.json")), null);
    } finally {
      rmTemp(dir);
    }
  });
});

function deps(over: Partial<EvidenceDeps> = {}) {
  const state = { proveCalls: 0, stored: null as GateProof | null };
  const d: EvidenceDeps = {
    now: () => NOW,
    version: "7.1.0",
    liveness: () => wired,
    readProof: () => state.stored,
    writeProof: (p) => {
      state.stored = p;
    },
    prove: () => {
      state.proveCalls++;
      return { total: 6, failed: [] };
    },
    canRun: () => true,
    skipped: async () => ({ entries: [] }),
    ...over,
  };
  return { ...d, state };
}

describe("checkEnforcementEvidence", () => {
  it("runs the controls when there is no fresh proof, stores the result, and passes", async () => {
    const d = deps();
    const r = await checkEnforcementEvidence("/x", d);
    assert.equal(r.status, "pass");
    assert.equal(d.state.proveCalls, 1);
    assert.equal(d.state.stored?.total, 6);
    assert.equal(d.state.stored?.version, "7.1.0");
  });

  it("does not run them again while the proof is fresh", async () => {
    const d = deps({ readProof: () => proof() });
    const r = await checkEnforcementEvidence("/x", d);
    assert.equal(r.status, "pass");
    assert.equal(d.state.proveCalls, 0);
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

  it("records a failed control and fails the row", async () => {
    const d = deps({
      prove: () => ({ total: 6, failed: ["install gate refuses an unverifiable install"] }),
    });
    const r = await checkEnforcementEvidence("/x", d);
    assert.equal(r.status, "fail");
    assert.equal(d.state.stored?.failed.length, 1);
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

  it("reads the stored file back, so the proof survives between runs", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-proof-rt-"));
    try {
      const file = join(dir, "gate-proof.json");
      writeProofFile(file, proof());
      assert.match(readFileSync(file, "utf8"), /"total": 6/);
    } finally {
      rmTemp(dir);
    }
  });
});
