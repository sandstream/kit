/** Read and preserve signed review history and receipt files. */
import { closeSync, readSync } from "node:fs";
import { join } from "node:path";
import { tryReadAuditAnchorKey } from "./audit-anchor.js";
import { appendReceiptHistory, openReceiptForRead } from "./review-receipt-files.js";
import { verifyReviewReceipt, type SignedReviewReceipt } from "./review-receipt.js";

export const REVIEW_RECEIPT_HISTORY_FILE = ".kit-review-receipt-history.jsonl";
const MAX_RECEIPT_BYTES = 16 * 1024 * 1024;

export function readReceipt(path: string): string | null {
  const fd = openReceiptForRead(path);
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (total <= MAX_RECEIPT_BYTES) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_RECEIPT_BYTES + 1 - total));
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) return Buffer.concat(chunks, total).toString("utf8");
      total += count;
      if (total > MAX_RECEIPT_BYTES) return null;
      chunks.push(chunk.subarray(0, count));
    }
    return null;
  } finally {
    closeSync(fd);
  }
}

export function countFailedReviewReceipts(
  receipts: SignedReviewReceipt[],
  key: Buffer,
  head: string,
  command: string,
): number {
  const failures = new Set<string>();
  const runs = new Map<string, string>();
  for (const receipt of receipts) {
    if (!/^[a-f0-9]{40}$/.test(receipt.head)) throw new Error("invalid receipt history head");
    const verdict = verifyReviewReceipt(receipt, key, receipt.head, { allowLegacy: true });
    if (!verdict.ok) throw new Error(`invalid receipt history signature: ${verdict.reason}`);
    if ((receipt.schema as string) === "kit-pr-review-receipt/v3") {
      const previous = runs.get(receipt.run_id);
      if (previous && previous !== receipt.signature)
        throw new Error("conflicting review run in history");
      runs.set(receipt.run_id, receipt.signature);
    }
    if (
      receipt.head === head &&
      receipt.gate.command === command &&
      receipt.gate.exit_code !== 0 &&
      receipt.run_status !== "interrupted"
    ) {
      failures.add(
        (receipt.schema as string) === "kit-pr-review-receipt/v3"
          ? receipt.run_id
          : receipt.signature,
      );
    }
  }
  return failures.size;
}

export async function readFailedReviewSummary(
  root: string,
  head: string,
  command: string,
): Promise<{ count: number; last: SignedReviewReceipt | null }> {
  const path = join(root, REVIEW_RECEIPT_HISTORY_FILE);
  let content: string | null;
  try {
    content = readReceipt(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { count: 0, last: null };
    throw error;
  }
  if (content === null) throw new Error("review receipt history is too large");
  const lines = content.split("\n").filter(Boolean);
  if (lines.length === 0) return { count: 0, last: null };
  const key = await tryReadAuditAnchorKey();
  if (!key) throw new Error("review receipt history signing key is unavailable");
  const receipts = lines.map((line) => JSON.parse(line) as SignedReviewReceipt);
  const count = countFailedReviewReceipts(receipts, key, head, command);
  const last =
    [...receipts]
      .reverse()
      .find(
        (item) =>
          item.head === head &&
          item.gate.command === command &&
          item.gate.exit_code !== 0 &&
          item.run_status !== "interrupted",
      ) ?? null;
  return { count, last };
}

export async function readFailedReviewRuns(
  root: string,
  head: string,
  command: string,
): Promise<number> {
  return (await readFailedReviewSummary(root, head, command)).count;
}

function readHistory(root: string, key: Buffer): SignedReviewReceipt[] {
  let content: string | null;
  try {
    content = readReceipt(join(root, REVIEW_RECEIPT_HISTORY_FILE));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (content === null) throw new Error("review receipt history is too large");
  const receipts = content
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SignedReviewReceipt);
  for (const entry of receipts) {
    if (!verifyReviewReceipt(entry, key, entry.head, { allowLegacy: true }).ok) {
      throw new Error("invalid review receipt history signature");
    }
  }
  return receipts;
}

export function persistHistory(root: string, signed: SignedReviewReceipt, key: Buffer): void {
  const history = readHistory(root, key);
  countFailedReviewReceipts(history, key, signed.head, signed.gate.command);
  if (signed.gate.exit_code === 0 && signed.run_status !== "interrupted") return;
  const prior = history.find((item) => item.run_id === signed.run_id);
  if (prior && prior.signature !== signed.signature)
    throw new Error("conflicting review run in history");
  if (!prior) {
    appendReceiptHistory(join(root, REVIEW_RECEIPT_HISTORY_FILE), JSON.stringify(signed) + "\n");
  }
  if (!readHistory(root, key).some((item) => item.signature === signed.signature)) {
    throw new Error("review history did not retain the signed run");
  }
}
