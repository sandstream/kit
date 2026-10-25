import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkTranscriptSecrets } from "./check-transcripts.js";
import { actionableFindings, securityFindingToSync } from "./findings-track.js";

const HIT = {
  file: "/home/u/.claude/projects/p/a.jsonl",
  findings: [{ label: "aws-access-key", preview: "AKIA…ZZ" }],
};

describe("checkTranscriptSecrets", () => {
  it("passes when no transcript holds a credential", async () => {
    const r = await checkTranscriptSecrets(async () => []);
    assert.equal(r.status, "pass");
    assert.equal(r.category, "secrets");
  });

  it("warns, names the file and the rotation, and never prints a value", async () => {
    const r = await checkTranscriptSecrets(async () => [HIT]);
    assert.equal(r.status, "warn");
    assert.equal(r.severity, "high");
    assert.match(r.detail, /1 potential secret/);
    assert.deepEqual(r.files, [HIT.file]);
    assert.match(r.suggestion ?? "", /rotate/i);
    assert.ok(!r.detail.includes("AKIA"));
  });

  it("opens a rotation item: the warning is tracked, with a stable key", async () => {
    const r = await checkTranscriptSecrets(async () => [HIT]);
    const tracked = actionableFindings([r]);
    assert.equal(tracked.length, 1);
    const sync = securityFindingToSync(tracked[0]);
    assert.equal(sync.dedupKey, "secrets:agent transcripts");
    assert.match(sync.detail ?? "", /rotate/i);
  });

  it("says it did not run when the scan throws", async () => {
    const r = await checkTranscriptSecrets(async () => {
      throw new Error("boom");
    });
    assert.equal(r.status, "warn");
    assert.equal(r.didNotRun, true);
    assert.match(r.detail, /boom/);
  });
});
