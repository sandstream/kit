import { it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAuditAnchorKey } from "./audit-anchor.js";
import {
  persistHistory,
  readFailedReviewRuns,
  readFailedReviewSummary,
  REVIEW_RECEIPT_HISTORY_FILE,
} from "./review-receipt-history-io.js";
import { buildReviewReceipt, signReviewReceipt } from "./review-receipt.js";

const HEAD = "a".repeat(40);
const COMMAND = "kit review --receipt";

async function withHistory(test: (root: string, key: Buffer) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "kit-review-history-io-"));
  const root = join(directory, "project");
  const anchor = join(directory, "anchor");
  mkdirSync(root);
  const previous = process.env.KIT_AUDIT_ANCHOR_DIR;
  process.env.KIT_AUDIT_ANCHOR_DIR = anchor;
  try {
    const key = await getAuditAnchorKey(anchor);
    await test(root, key);
  } finally {
    if (previous === undefined) delete process.env.KIT_AUDIT_ANCHOR_DIR;
    else process.env.KIT_AUDIT_ANCHOR_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  }
}

function receipt(key: Buffer, runId: string, exitCode = 1, interrupted = false) {
  return signReviewReceipt(
    buildReviewReceipt({
      repo: "sandstream/kit",
      pr: 12,
      localHead: HEAD,
      remoteHead: HEAD,
      baseBranch: "main",
      baseHead: HEAD,
      policyBranch: "main",
      policyHead: HEAD,
      runId: runId.repeat(32),
      runStatus: interrupted ? "interrupted" : "completed",
      createdAt: "2026-10-29T10:00:00.000Z",
      gate: { command: COMMAND, exitCode, stdout: runId, stderr: "" },
      checks: [],
      threads: [],
      changedPaths: [],
      protectedPaths: [],
    }),
    key,
  );
}

it("persists separate signed failures once and returns their verified summary", async () => {
  await withHistory(async (root, key) => {
    const first = receipt(key, "1");
    const second = receipt(key, "2");
    persistHistory(root, first, key);
    persistHistory(root, first, key);
    persistHistory(root, second, key);
    const summary = await readFailedReviewSummary(root, HEAD, COMMAND);
    assert.equal(summary.count, 2);
    assert.equal(summary.last?.signature, second.signature);
    assert.deepEqual(summary.signatures, [first.signature, second.signature]);
    assert.equal(await readFailedReviewRuns(root, HEAD, COMMAND), 2);
    assert.equal(
      readFileSync(join(root, REVIEW_RECEIPT_HISTORY_FILE), "utf8").split("\n").length,
      3,
    );
  });
});

it("keeps an interrupted review without counting it as a confirmed failure", async () => {
  await withHistory(async (root, key) => {
    const interrupted = receipt(key, "3", 1, true);
    persistHistory(root, interrupted, key);
    const summary = await readFailedReviewSummary(root, HEAD, COMMAND);
    assert.equal(summary.count, 0);
    assert.equal(summary.last, null);
    assert.deepEqual(summary.signatures, [interrupted.signature]);
  });
});

it("returns an empty summary when no history exists", async () => {
  await withHistory(async (root) => {
    assert.deepEqual(await readFailedReviewSummary(root, HEAD, COMMAND), {
      count: 0,
      last: null,
      signatures: [],
    });
    assert.equal(existsSync(join(root, REVIEW_RECEIPT_HISTORY_FILE)), false);
  });
});

for (const corrupt of ['{"incomplete":', '{"not":"signed"}\n']) {
  it(`rejects and preserves corrupt history: ${JSON.stringify(corrupt)}`, async () => {
    await withHistory(async (root, key) => {
      const path = join(root, REVIEW_RECEIPT_HISTORY_FILE);
      writeFileSync(path, corrupt);
      assert.throws(() => persistHistory(root, receipt(key, "4", 0), key), /history/i);
      await assert.rejects(readFailedReviewSummary(root, HEAD, COMMAND), /history/i);
      assert.equal(readFileSync(path, "utf8"), corrupt);
    });
  });
}
