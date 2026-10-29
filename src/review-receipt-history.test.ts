import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildReviewReceipt, signReviewReceipt } from "./review-receipt.js";
import { countFailedReviewReceipts } from "./review-receipt-io.js";

const HEAD = "a".repeat(40);
const KEY = Buffer.alloc(32, 7);

function failed(head: string, createdAt: string) {
  return signReviewReceipt(
    buildReviewReceipt({
      repo: "sandstream/kit",
      pr: 12,
      localHead: head,
      remoteHead: head,
      createdAt,
      gate: { command: "kit review --receipt", exitCode: 1, stdout: "red", stderr: "" },
      checks: [],
      threads: [],
      changedPaths: [],
      protectedPaths: [],
    }),
    KEY,
  );
}

describe("countFailedReviewReceipts", () => {
  it("counts distinct signed failures for the same head and command", () => {
    const one = failed(HEAD, "2026-10-29T10:00:00.000Z");
    const two = failed(HEAD, "2026-10-29T10:01:00.000Z");
    const old = failed("b".repeat(40), "2026-10-29T09:00:00.000Z");
    assert.equal(
      countFailedReviewReceipts([one, one, two, old], KEY, HEAD, "kit review --receipt"),
      2,
    );
  });

  it("refuses altered history instead of hiding a failed run", () => {
    const changed = failed(HEAD, "2026-10-29T10:00:00.000Z");
    changed.gate.exit_code = 0;
    assert.throws(
      () => countFailedReviewReceipts([changed], KEY, HEAD, "kit review --receipt"),
      /signature/i,
    );
  });
});
