import { it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultReadCommand } from "./review-receipt-io.js";
import {
  assertReviewReadStamp,
  beginReviewTransaction,
  finishReviewTransaction,
  reviewReadStamp,
  reviewStarted,
} from "./review-receipt-transaction.js";

it("rejects a read when a whole review transaction occurs during it", () => {
  const root = mkdtempSync(join(tmpdir(), "kit-review-stamp-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    const before = reviewReadStamp(root, defaultReadCommand);
    const transaction = beginReviewTransaction(root, defaultReadCommand);
    assert.throws(() => reviewReadStamp(root, defaultReadCommand), /running or incomplete/);
    finishReviewTransaction(transaction);
    assert.throws(
      () => assertReviewReadStamp(root, defaultReadCommand, before),
      /changed while reading/,
    );
    assert.doesNotThrow(() => reviewReadStamp(root, defaultReadCommand));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("refuses a dangling review start marker instead of treating it as absent", (t) => {
  const root = mkdtempSync(join(tmpdir(), "kit-review-start-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    const transaction = beginReviewTransaction(root, defaultReadCommand);
    try {
      symlinkSync(join(root, "missing"), join(transaction.dir, "started"));
    } catch (error) {
      if (
        process.platform === "win32" &&
        ["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")
      ) {
        t.skip("Windows cannot create symbolic links in this test environment");
        return;
      }
      throw error;
    }
    assert.throws(() => reviewStarted(transaction), /invalid review transaction file/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
