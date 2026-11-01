/** Verify a local signed review receipt against current PR evidence. */
import { resolve } from "node:path";
import { tryReadProtectedAuditAnchorKey } from "./audit-anchor.js";
import { assertPrRefsUnchanged, readPrRefs } from "./review-protected-paths-github.js";
import {
  defaultReadCommand,
  gitHead,
  prEvidence,
  type ReadCommand,
} from "./review-receipt-evidence.js";
import { readReceipt, readFailedReviewSummary } from "./review-receipt-history-io.js";
import { assertReviewReadStamp, reviewReadStamp } from "./review-receipt-transaction.js";
import { cleanReviewWorktree, REVIEW_RECEIPT_FILE } from "./review-receipt-worktree.js";
import { verifyReviewReceipt, type SignedReviewReceipt } from "./review-receipt.js";

async function verifyReceiptHistory(
  root: string,
  receipt: SignedReviewReceipt,
): Promise<string | null> {
  try {
    const history = await readFailedReviewSummary(root, receipt.head, receipt.gate.command);
    const unresolved = history.unresolved.filter(
      (item) => item.repo === receipt.repo && item.pr === receipt.pr,
    );
    if (unresolved.length > 0) {
      const identities = unresolved.map((item) => item.run_id + " (" + item.head + ")").join(", ");
      return `unresolved interrupted reviews: ${identities}; inspect and record a risk assessment`;
    }
    if (receipt.gate.exit_code !== 0 && !history.signatures.includes(receipt.signature)) {
      return "failed review is missing from signed history";
    }
    return null;
  } catch (error) {
    return `review history cannot be verified: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function verifyReviewReceiptFile(
  cwd: string,
  file = REVIEW_RECEIPT_FILE,
  run: ReadCommand = defaultReadCommand,
): Promise<{ ok: boolean; reason: string; receipt?: SignedReviewReceipt }> {
  const root = resolve(run("git", ["rev-parse", "--show-toplevel"], cwd).trim());
  const stamp = reviewReadStamp(root, run);
  cleanReviewWorktree(root, run);
  const json = readReceipt(resolve(root, file));
  if (json === null) {
    return { ok: false, reason: "review receipt is too large" };
  }
  const receipt = JSON.parse(json) as SignedReviewReceipt;
  const key = await tryReadProtectedAuditAnchorKey();
  if (!key) return { ok: false, reason: "review receipt signing key is unavailable" };
  const head = gitHead(root, run);
  const signature = verifyReviewReceipt(receipt, key, head);
  if (!signature.ok) return signature;
  if (receipt.run_status === "interrupted") {
    return { ok: false, reason: "review was interrupted; run a new review" };
  }
  if (receipt.gate_only) {
    return { ok: false, reason: "local gate result lacks current PR evidence; run a new review" };
  }
  const historyError = await verifyReceiptHistory(root, receipt);
  if (historyError) return { ok: false, reason: historyError };
  const pr = prEvidence(root, run);
  const repoResponse = JSON.parse(run("gh", ["repo", "view", "--json", "nameWithOwner"], root)) as {
    nameWithOwner?: unknown;
  };
  if (
    receipt.repo !== repoResponse.nameWithOwner ||
    receipt.pr !== pr.number ||
    receipt.head !== pr.head
  ) {
    return { ok: false, reason: "review receipt does not match the current pull request" };
  }
  const refs = readPrRefs(root, receipt.repo, receipt.pr, run);
  if (
    refs.head !== receipt.head ||
    refs.baseName !== receipt.base_branch ||
    refs.base !== receipt.base_head ||
    refs.defaultName !== receipt.policy_branch ||
    refs.defaultHead !== receipt.policy_head
  ) {
    return { ok: false, reason: "review receipt does not match the current PR base or head" };
  }
  assertPrRefsUnchanged(refs, root, receipt.repo, run);
  assertReviewReadStamp(root, run, stamp);
  return { ...signature, receipt };
}
