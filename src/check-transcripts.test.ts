import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkTranscriptSecrets } from "./check-transcripts.js";
import { evidenceFor, indexResults } from "./coverage/coverage.js";
import { gateStatus } from "./check-security.js";
import type { TranscriptScan } from "./scan-transcripts.js";
import { actionableFindings, securityFindingToSync } from "./findings-track.js";

const HIT = {
  file: "/home/u/.claude/projects/p/a.jsonl",
  findings: [
    {
      label: "aws-access-key",
      preview: "AKIA…ZZ",
      evidence: { file: "transcript.jsonl", line: 1, pattern: "aws-access-key" },
    },
  ],
};

function scanned(hits: TranscriptScan["hits"] = []): TranscriptScan {
  return {
    hits,
    evidenceStatus: hits.length === 0 ? "complete-empty" : "complete",
    directoriesScanned: 1,
    filesScanned: 1,
    gaps: {},
  };
}

describe("checkTranscriptSecrets", () => {
  it("passes when no transcript holds a credential", async () => {
    const r = await checkTranscriptSecrets(async () => scanned());
    assert.equal(r.status, "pass");
    assert.equal(r.category, "secrets");
  });

  it("warns, names the file and the rotation, and never prints a value", async () => {
    const r = await checkTranscriptSecrets(async () => scanned([HIT]));
    assert.equal(r.status, "warn");
    assert.equal(r.severity, "high");
    assert.match(r.detail, /1 potential secret/);
    assert.deepEqual(r.files, [HIT.file]);
    assert.match(r.suggestion ?? "", /rotate/i);
    assert.ok(!r.detail.includes("AKIA"));
  });

  it("opens a rotation item: the warning is tracked, with a stable key", async () => {
    const r = await checkTranscriptSecrets(async () => scanned([HIT]));
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
    assert.equal(r.evidenceStatus, "unavailable");
    assert.equal(r.detail, "Could not scan agent transcripts");
  });
});

describe("transcript coverage at the gate", () => {
  it("does not claim coverage when no project transcript directory exists", async () => {
    const row = await checkTranscriptSecrets(async () => ({
      ...scanned(),
      directoriesScanned: 0,
      filesScanned: 0,
      evidenceStatus: "missing",
    }));
    assert.equal(gateStatus(row), "skip");
    assert.equal(evidenceFor(["scan-transcripts"], indexResults([row])), "unrun");
  });

  it("blocks strict checks on partial scope and keeps the findings", async () => {
    const row = await checkTranscriptSecrets(async () => ({
      ...scanned([HIT]),
      gaps: { unreadable: 1 },
      evidenceStatus: "partial",
    }));
    assert.equal(row.scanIncomplete, true);
    assert.equal(row.hasFindings, true);
    assert.equal(row.evidenceStatus, "partial");
    assert.equal(gateStatus(row), "fail");
    assert.deepEqual(row.files, [HIT.file]);
    assert.match(row.detail, /Coverage unverified.*unreadable/);
    assert.equal(evidenceFor(["scan-transcripts"], indexResults([row])), "unrun");
  });

  it("allows coverage after a complete empty scan", async () => {
    const row = await checkTranscriptSecrets(async () => scanned());
    assert.equal(evidenceFor(["scan-transcripts"], indexResults([row])), "verified");
  });
});
