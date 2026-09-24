import type { MergeResult } from "../memory/merge.js";

/** Count persisted payload changes, excluding replay-only bookkeeping. */
export function mergePayloadChanges(result: MergeResult): number {
  return (
    result.messages +
    result.toolUses +
    result.pending +
    result.threads +
    result.tombstones +
    result.tombstoneDeletedMessages +
    result.scopeRepairs +
    result.protectionRepairs
  );
}
