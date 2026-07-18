import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseObserveRecords,
  assessEnforceReadiness,
  type ObserveRecord,
} from "./enforce-readiness.js";

/** Shape a real observe audit line as broker.ts writes it: metadata.phase + metadata.wouldDeny. */
const observeLine = (wouldDeny: string[], extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    operation: "bash",
    success: true,
    metadata: { phase: "observe", wouldDeny, ...extra },
  });

describe("parseObserveRecords", () => {
  it("keeps only observe-phase lines and lifts wouldDeny verbatim", () => {
    const jsonl = [
      observeLine([]),
      observeLine(["exec-broker: egress api.evil.test not in scope"]),
      JSON.stringify({ metadata: { phase: "authorized" } }), // non-observe → skipped
      JSON.stringify({ metadata: { phase: "enforce-enabled" } }), // non-observe → skipped
    ].join("\n");
    const records = parseObserveRecords(jsonl);
    assert.equal(records.length, 2);
    assert.deepEqual(records[0].wouldDeny, []);
    assert.deepEqual(records[1].wouldDeny, ["exec-broker: egress api.evil.test not in scope"]);
  });

  it("is tolerant: blank, whitespace, and malformed lines are skipped, never thrown", () => {
    const jsonl = ["", "   ", "{not json", observeLine(["r1"]), "null", "42"].join("\n");
    const records = parseObserveRecords(jsonl);
    assert.equal(records.length, 1);
    assert.deepEqual(records[0].wouldDeny, ["r1"]);
  });

  it("treats a missing or non-array wouldDeny as an empty (would-pass) op", () => {
    const jsonl = [
      JSON.stringify({ metadata: { phase: "observe" } }), // no wouldDeny
      JSON.stringify({ metadata: { phase: "observe", wouldDeny: "oops" } }), // wrong type
      JSON.stringify({ metadata: { phase: "observe", wouldDeny: [1, "keep", null] } }), // mixed
    ].join("\n");
    const records = parseObserveRecords(jsonl);
    assert.equal(records.length, 3);
    assert.deepEqual(records[0].wouldDeny, []);
    assert.deepEqual(records[1].wouldDeny, []);
    assert.deepEqual(records[2].wouldDeny, ["keep"]); // non-strings filtered out
  });

  it("returns [] for empty input", () => {
    assert.deepEqual(parseObserveRecords(""), []);
    assert.deepEqual(parseObserveRecords("\n\n"), []);
  });
});

describe("assessEnforceReadiness", () => {
  it("no observe data → untested (honest floor, never a green ready)", () => {
    const r = assessEnforceReadiness([]);
    assert.equal(r.verdict, "untested");
    assert.equal(r.opsObserved, 0);
    assert.equal(r.wouldBlockOps, 0);
    assert.deepEqual(r.reasons, []);
  });

  it("all observed ops would pass → ready", () => {
    const records: ObserveRecord[] = [{ wouldDeny: [] }, { wouldDeny: [] }, { wouldDeny: [] }];
    const r = assessEnforceReadiness(records);
    assert.equal(r.verdict, "ready");
    assert.equal(r.opsObserved, 3);
    assert.equal(r.wouldBlockOps, 0);
    assert.deepEqual(r.reasons, []);
  });

  it("any op with a would-be denial → would-block", () => {
    const records: ObserveRecord[] = [{ wouldDeny: [] }, { wouldDeny: ["egress X"] }];
    const r = assessEnforceReadiness(records);
    assert.equal(r.verdict, "would-block");
    assert.equal(r.opsObserved, 2);
    assert.equal(r.wouldBlockOps, 1);
  });

  it("counts blocking ops (not total reasons) and tallies reasons across ops", () => {
    const records: ObserveRecord[] = [
      { wouldDeny: ["egress X", "fs /etc"] }, // one op, two reasons
      { wouldDeny: ["egress X"] },
      { wouldDeny: [] },
    ];
    const r = assessEnforceReadiness(records);
    assert.equal(r.opsObserved, 3);
    assert.equal(r.wouldBlockOps, 2);
    assert.deepEqual(r.reasons, [
      { reason: "egress X", count: 2 },
      { reason: "fs /etc", count: 1 },
    ]);
  });

  it("sorts reasons by count desc, then reason asc for a stable, deterministic report", () => {
    const records: ObserveRecord[] = [
      { wouldDeny: ["bbb"] },
      { wouldDeny: ["aaa"] },
      { wouldDeny: ["aaa"] },
      { wouldDeny: ["ccc"] },
    ];
    const r = assessEnforceReadiness(records);
    assert.deepEqual(r.reasons, [
      { reason: "aaa", count: 2 }, // highest count first
      { reason: "bbb", count: 1 }, // ties broken alphabetically
      { reason: "ccc", count: 1 },
    ]);
  });
});
