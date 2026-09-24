import { it } from "node:test";
import assert from "node:assert/strict";
import type { MergeResult } from "../memory/merge.js";
import { mergePayloadChanges } from "./memory-merge-summary.js";

function result(changes: Partial<MergeResult> = {}): MergeResult {
  return {
    messages: 0,
    toolUses: 0,
    scopeRepairs: 0,
    protectionRepairs: 0,
    tombstoneBlockedMessages: 0,
    pending: 0,
    pendingScopeRepairs: 0,
    pendingIdRemaps: 0,
    pendingStateDifferences: 0,
    pendingDifferenceIds: [],
    pendingLegacySnapshots: 0,
    sessions: 0,
    tombstones: 0,
    tombstoneDeletedMessages: 0,
    threads: 0,
    projects: {},
    ...changes,
  };
}

it("treats session and replay bookkeeping as no payload change", () => {
  const replay = result({
    sessions: 2,
    projects: { project: 2 },
    tombstoneBlockedMessages: 1,
    pendingIdRemaps: 3,
    pendingStateDifferences: 4,
    pendingDifferenceIds: ["old-id"],
    pendingLegacySnapshots: 5,
  });
  assert.equal(mergePayloadChanges(replay), 0);
});

it("counts deletion and protection repairs as publishable changes", () => {
  const changed = result({
    messages: 1,
    toolUses: 2,
    pending: 1,
    threads: 1,
    tombstones: 1,
    tombstoneDeletedMessages: 1,
    scopeRepairs: 1,
    protectionRepairs: 1,
  });
  assert.equal(mergePayloadChanges(changed), 9);
});
