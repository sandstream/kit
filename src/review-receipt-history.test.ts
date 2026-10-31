import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  buildReviewReceipt,
  signReviewReceipt,
  verifyReviewReceipt,
  type SignedReviewReceipt,
} from "./review-receipt.js";
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
      baseBranch: "main",
      baseHead: "b".repeat(40),
      policyBranch: "main",
      policyHead: "b".repeat(40),
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

  it("does not count interrupted reviews as confirmed gate failures", () => {
    const {
      signature: _signature,
      sig_alg: _algorithm,
      ...body
    } = failed(HEAD, "2026-10-29T10:00:00.000Z");
    const interrupted = signReviewReceipt({ ...body, run_status: "interrupted" }, KEY);
    assert.equal(countFailedReviewReceipts([interrupted], KEY, HEAD, "kit review --receipt"), 0);
  });

  it("rejects two different signed results for the same run", () => {
    const one = failed(HEAD, "2026-10-29T10:00:00.000Z");
    const { signature: _signature, sig_alg: _algorithm, ...body } = one;
    const other = signReviewReceipt(
      { ...body, gate: { ...body.gate, output_sha256: "c".repeat(64) } },
      KEY,
    );
    assert.throws(
      () => countFailedReviewReceipts([one, other], KEY, HEAD, "kit review --receipt"),
      /conflicting review run/,
    );
  });

  it("keeps signed v2 receipts readable as current evidence", () => {
    const current = failed(HEAD, "2026-10-29T10:00:00.000Z");
    const { signature: _signature, run_id: _runId, run_status: _runStatus, ...rest } = current;
    const body = { ...rest, schema: "kit-pr-review-receipt/v2" };
    const signature = createHmac("sha256", KEY).update(JSON.stringify(body)).digest("base64");
    const legacy = { ...body, signature } as unknown as SignedReviewReceipt;
    assert.equal(verifyReviewReceipt(legacy, KEY, HEAD).ok, true);
    assert.equal(countFailedReviewReceipts([legacy, legacy], KEY, HEAD, "kit review --receipt"), 1);
  });

  it("keeps signed v1 history readable without accepting it as a current receipt", () => {
    const current = failed(HEAD, "2026-10-29T10:00:00.000Z");
    const {
      signature: _signature,
      base_branch: _baseBranch,
      base_head: _baseHead,
      policy_branch: _policyBranch,
      policy_head: _policyHead,
      ...rest
    } = current;
    const body = { ...rest, schema: "kit-pr-review-receipt/v1" };
    const signature = createHmac("sha256", KEY).update(JSON.stringify(body)).digest("base64");
    const legacy = { ...body, signature } as unknown as SignedReviewReceipt;
    assert.equal(countFailedReviewReceipts([legacy], KEY, HEAD, "kit review --receipt"), 1);
    assert.equal(verifyReviewReceipt(legacy, KEY, HEAD).ok, false);
    legacy.gate.exit_code = 0;
    assert.throws(
      () => countFailedReviewReceipts([legacy], KEY, HEAD, "kit review --receipt"),
      /signature/i,
    );
  });
});
