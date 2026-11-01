/** Read and preserve signed review history and receipt files. */
import { closeSync, readSync } from "node:fs";
import { join } from "node:path";
import { tryReadProtectedAuditAnchorKey } from "./audit-anchor.js";
import {
  appendReceiptHistory,
  decodeReceiptUtf8,
  MAX_RECEIPT_BYTES,
  openReceiptForRead,
} from "./review-receipt-files.js";
import { verifyReviewReceipt, type SignedReviewReceipt } from "./review-receipt.js";
import { assertReviewWritable } from "./review-receipt-write-guard.js";

export const REVIEW_RECEIPT_HISTORY_FILE = ".kit-review-receipt-history.jsonl";

function historyGuidance(path: string, lockDir?: string): string {
  const evidence = lockDir
    ? `Preserve pending evidence at ${join(lockDir, "pending.json")} and any staged files.`
    : "If a review transaction exists, preserve its pending evidence and staged files.";
  const retry = lockDir ? "retry recovery" : "retry verification or start a new review";
  return `Review history at ${path} is incomplete or invalid. Preserve its original bytes. ${evidence} Have a qualified person inspect and repair a separate copy. Keep the original backup, put the verified copy at ${path}, and ${retry}.`;
}

function parseHistory(content: string, path: string, lockDir?: string): SignedReviewReceipt[] {
  const message = historyGuidance(path, lockDir);
  if (content.length > 0 && !content.endsWith("\n")) throw new Error(message);
  try {
    return content
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as SignedReviewReceipt);
  } catch (error) {
    throw new Error(message, { cause: error });
  }
}

export function readReceipt(path: string): string | null {
  const fd = openReceiptForRead(path);
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (total <= MAX_RECEIPT_BYTES) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_RECEIPT_BYTES + 1 - total));
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) return decodeReceiptUtf8(Buffer.concat(chunks, total));
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
): Promise<{
  count: number;
  last: SignedReviewReceipt | null;
  signatures: string[];
  unresolved: SignedReviewReceipt[];
}> {
  const path = join(root, REVIEW_RECEIPT_HISTORY_FILE);
  let content: string | null;
  try {
    content = readReceipt(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { count: 0, last: null, signatures: [], unresolved: [] };
    if (error instanceof TypeError) throw new Error(historyGuidance(path), { cause: error });
    throw error;
  }
  if (content === null) throw new Error("review receipt history is too large");
  const receipts = parseHistory(content, path);
  if (receipts.length === 0) return { count: 0, last: null, signatures: [], unresolved: [] };
  const key = await tryReadProtectedAuditAnchorKey();
  if (!key) throw new Error("review receipt history signing key is unavailable");
  let count: number;
  try {
    count = countFailedReviewReceipts(receipts, key, head, command);
  } catch (error) {
    throw new Error(
      `${historyGuidance(path)} ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
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
  return {
    count,
    last,
    signatures: receipts.map((item) => item.signature),
    unresolved: unresolvedInterruptions(receipts),
  };
}

function resolutionMatches(
  resolution: SignedReviewReceipt,
  original: SignedReviewReceipt,
): boolean {
  return (
    resolution.run_status === "interrupted" &&
    resolution.interruption_disposition === "risk-accepted" &&
    typeof resolution.interruption_review === "string" &&
    resolution.interruption_review.trim().length >= 10 &&
    resolution.repo === original.repo &&
    resolution.pr === original.pr &&
    resolution.head === original.head &&
    resolution.base_head === original.base_head &&
    resolution.base_branch === original.base_branch &&
    resolution.policy_head === original.policy_head &&
    resolution.policy_branch === original.policy_branch
  );
}

export function unresolvedInterruptions(receipts: SignedReviewReceipt[]): SignedReviewReceipt[] {
  const unknown = receipts.filter(
    (entry) => entry.run_status === "interrupted" && !entry.resolves_run_id,
  );
  const resolutions = receipts.filter((entry) => entry.resolves_run_id);
  for (const resolution of resolutions) {
    const original = unknown.find((item) => item.run_id === resolution.resolves_run_id);
    if (!original || !resolutionMatches(resolution, original)) {
      throw new Error("invalid review interruption assessment");
    }
  }
  return unknown.filter(
    (item) =>
      !(
        item.interruption_disposition === "risk-accepted" &&
        typeof item.interruption_review === "string" &&
        item.interruption_review.trim().length >= 10
      ) && !resolutions.some((resolution) => resolution.resolves_run_id === item.run_id),
  );
}

export async function readFailedReviewRuns(
  root: string,
  head: string,
  command: string,
): Promise<number> {
  return (await readFailedReviewSummary(root, head, command)).count;
}

export function readHistory(root: string, key: Buffer, lockDir?: string): SignedReviewReceipt[] {
  const path = join(root, REVIEW_RECEIPT_HISTORY_FILE);
  let content: string | null;
  try {
    content = readReceipt(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    if (error instanceof TypeError)
      throw new Error(historyGuidance(path, lockDir), { cause: error });
    throw error;
  }
  if (content === null) throw new Error("review receipt history is too large");
  const receipts = parseHistory(content, path, lockDir);
  try {
    for (const entry of receipts) {
      if (!verifyReviewReceipt(entry, key, entry.head, { allowLegacy: true }).ok) {
        throw new Error("invalid history signature");
      }
    }
  } catch (error) {
    throw new Error(`${historyGuidance(path, lockDir)} Invalid history entry.`, { cause: error });
  }
  return receipts;
}

export function persistHistory(
  root: string,
  signed: SignedReviewReceipt,
  key: Buffer,
  lockDir?: string,
  hooks?: {
    publish?: typeof import("node:fs").linkSync;
    write?: (fd: number, text: string) => void;
  },
): void {
  assertReviewWritable(root, "review-history");
  const history = readHistory(root, key, lockDir);
  try {
    countFailedReviewReceipts(history, key, signed.head, signed.gate.command);
    unresolvedInterruptions(signed.resolves_run_id ? [...history, signed] : history);
  } catch (error) {
    throw new Error(
      `${historyGuidance(join(root, REVIEW_RECEIPT_HISTORY_FILE), lockDir)} ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (signed.gate.exit_code === 0 && signed.run_status !== "interrupted") return;
  const prior = history.find((item) => item.run_id === signed.run_id);
  if (prior && prior.signature !== signed.signature)
    throw new Error("conflicting review run in history");
  if (!prior) {
    appendReceiptHistory(join(root, REVIEW_RECEIPT_HISTORY_FILE), JSON.stringify(signed) + "\n", {
      publish: hooks?.publish,
      write: hooks?.write,
    });
  }
  if (!readHistory(root, key, lockDir).some((item) => item.signature === signed.signature)) {
    throw new Error("review history did not retain the signed run");
  }
}
