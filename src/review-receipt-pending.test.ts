import { it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assessUnknownPending, selectPendingReceipt } from "./review-receipt-pending.js";
import { buildReviewReceipt, signReviewReceipt, verifyReviewReceipt } from "./review-receipt.js";
import { defaultReadCommand } from "./review-receipt-io.js";
import {
  beginReviewTransaction,
  claimReviewRecovery,
  readReviewPending,
  writeReviewPending,
} from "./review-receipt-transaction.js";

const KEY = Buffer.alloc(32, 7);
const HEAD = "a".repeat(40);
const RUN = "b".repeat(32);

function body(runId = RUN, runStatus: "completed" | "interrupted" = "interrupted") {
  return buildReviewReceipt({
    repo: "sandstream/kit",
    pr: 12,
    localHead: HEAD,
    remoteHead: HEAD,
    baseBranch: "main",
    baseHead: HEAD,
    policyBranch: "main",
    policyHead: HEAD,
    runId,
    runStatus,
    createdAt: "2026-10-29T10:00:00.000Z",
    gate: { command: "kit review --receipt", exitCode: 1, stdout: "failure", stderr: "" },
    checks: [],
    threads: [],
    changedPaths: [],
    protectedPaths: [],
  });
}

it("prefers a complete signed review over staged and interrupted evidence", () => {
  const pending = signReviewReceipt(body(), KEY);
  const completed = body(RUN, "completed");
  const gateOnly = signReviewReceipt({ ...completed, gate_only: true }, KEY);
  const full = signReviewReceipt(completed, KEY);
  assert.deepEqual(
    selectPendingReceipt(
      JSON.stringify(pending),
      [JSON.stringify(gateOnly), JSON.stringify(full)],
      KEY,
      RUN,
    ),
    full,
  );
});

it("rejects conflicting signed results for the same run", () => {
  const first = signReviewReceipt(body(RUN, "completed"), KEY);
  const second = signReviewReceipt(
    { ...body(RUN, "completed"), gate: { ...first.gate, output_sha256: "c".repeat(64) } },
    KEY,
  );
  assert.throws(
    () => selectPendingReceipt(JSON.stringify(first), [JSON.stringify(second)], KEY, RUN),
    /conflicting completed pending reviews/,
  );
});

it("rejects invalid signatures, run identities, and malformed evidence", () => {
  const valid = signReviewReceipt(body(), KEY);
  const tampered = { ...valid, repo: "other/repo" };
  const differentRun = signReviewReceipt(body("c".repeat(32)), KEY);
  assert.throws(
    () => selectPendingReceipt(JSON.stringify(tampered), [], KEY, RUN),
    /signature or identity/,
  );
  assert.throws(
    () => selectPendingReceipt(JSON.stringify(differentRun), [], KEY, RUN),
    /signature or identity/,
  );
  assert.throws(() => selectPendingReceipt("{", [], KEY, RUN), SyntaxError);
});

it("rejects staged evidence for a different PR even when it is signed", () => {
  const original = body();
  const pending = signReviewReceipt(original, KEY);
  const otherPr = signReviewReceipt({ ...original, pr: 13 }, KEY);
  assert.throws(
    () => selectPendingReceipt(JSON.stringify(pending), [JSON.stringify(otherPr)], KEY, RUN),
    /pending review identity changed/,
  );
});

it("records an explicit interruption assessment with a valid signature", () => {
  const root = mkdtempSync(join(tmpdir(), "kit-review-pending-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    const transaction = beginReviewTransaction(root, defaultReadCommand);
    const signed = signReviewReceipt(body(transaction.runId), KEY);
    const initial = JSON.stringify(signed) + "\n";
    writeReviewPending(transaction, initial);
    const claim = claimReviewRecovery(transaction);
    const context = {
      transaction,
      claim,
      key: KEY,
      acknowledge: false,
      note: "Inspected evidence",
    };
    assert.throws(() => assessUnknownPending(signed, initial, context), /acknowledge-unknown/);
    assert.equal(readReviewPending(transaction), initial);
    const assessed = assessUnknownPending(signed, initial, {
      ...context,
      acknowledge: true,
      note: "  Inspected evidence  ",
    });
    assert.equal(assessed.signed.interruption_review, "Inspected evidence");
    assert.equal(assessed.signed.interruption_disposition, "risk-accepted");
    assert.equal(verifyReviewReceipt(assessed.signed, KEY, HEAD).ok, true);
    assert.equal(readReviewPending(transaction), assessed.pending);
    assert.deepEqual(
      selectPendingReceipt(initial, [assessed.pending], KEY, transaction.runId),
      assessed.signed,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
