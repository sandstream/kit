import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { readReceipt, readFailedReviewSummary } from "./review-receipt-history-io.js";
import { readReviewPending } from "./review-receipt-transaction.js";

it("rejects malformed UTF-8 rather than accepting replacement characters in a receipt", () => {
  const root = mkdtempSync(join(tmpdir(), "kit-receipt-utf8-"));
  try {
    const path = join(root, "receipt");
    const malformed = Buffer.concat([
      Buffer.from('{"note":"'),
      Buffer.from([0xff]),
      Buffer.from('"}'),
    ]);
    writeFileSync(path, malformed);
    assert.throws(() => readReceipt(path), /encoded data|encoding/i);
    writeFileSync(path, JSON.stringify({ note: "\ufffd" }));
    assert.deepEqual(JSON.parse(readReceipt(path)!), { note: "\ufffd" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("rejects malformed UTF-8 in pending transaction evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "kit-receipt-pending-utf8-"));
  try {
    writeFileSync(join(root, "pending.json"), Buffer.from([0xff]));
    assert.throws(
      () => readReviewPending({ root, dir: root, runId: "run", pid: process.pid, host: "host" }),
      /Invalid UTF-8.*Preserve the file/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("preserves malformed UTF-8 history and provides recovery guidance", async () => {
  const root = mkdtempSync(join(tmpdir(), "kit-history-utf8-"));
  try {
    const path = join(root, ".kit-review-receipt-history.jsonl");
    writeFileSync(path, Buffer.from([0xff, 0x0a]));
    await assert.rejects(
      readFailedReviewSummary(root, "a".repeat(40), "kit review --receipt"),
      (error: Error) =>
        error.message.includes(path) && error.message.includes("Preserve its original bytes"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
