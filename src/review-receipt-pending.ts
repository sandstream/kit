/** Validate staged review evidence and preserve explicit interruption assessments. */
import {
  signReviewReceipt,
  verifyReviewReceipt,
  type SignedReviewReceipt,
} from "./review-receipt.js";
import {
  writeRecoveryPending,
  type RecoveryClaim,
  type ReviewTransaction,
} from "./review-receipt-transaction.js";
import { assertReviewWritable } from "./review-receipt-write-guard.js";

function validatePendingIdentities(
  receipts: SignedReviewReceipt[],
  key: Buffer,
  runId: string,
): void {
  const first = receipts[0]!;
  for (const signed of receipts) {
    if (!verifyReviewReceipt(signed, key, signed.head).ok || signed.run_id !== runId) {
      throw new Error("pending review signature or identity is invalid");
    }
    if (
      signed.repo !== first.repo ||
      signed.pr !== first.pr ||
      signed.head !== first.head ||
      signed.base_branch !== first.base_branch ||
      signed.base_head !== first.base_head ||
      signed.policy_branch !== first.policy_branch ||
      signed.policy_head !== first.policy_head
    ) {
      throw new Error("pending review identity changed");
    }
  }
}

function selectReviewedPending(receipts: SignedReviewReceipt[]): SignedReviewReceipt | undefined {
  const interrupted = receipts.filter((item) => item.run_status === "interrupted");
  const reviewed = interrupted.filter((item) => item.interruption_disposition === "risk-accepted");
  const unreviewed = interrupted.filter(
    (item) => item.interruption_disposition !== "risk-accepted",
  );
  if (
    new Set(reviewed.map((item) => item.signature)).size > 1 ||
    new Set(unreviewed.map((item) => item.signature)).size > 1
  ) {
    throw new Error("conflicting interrupted pending reviews");
  }
  if (reviewed.length && unreviewed.length) {
    const clean = (item: SignedReviewReceipt) => {
      const {
        signature: _signature,
        interruption_review: _review,
        interruption_disposition: _disposition,
        ...body
      } = item;
      return JSON.stringify(body);
    };
    if (clean(reviewed[0]!) !== clean(unreviewed[0]!))
      throw new Error("conflicting interrupted pending reviews");
  }
  return reviewed[0];
}

function selectCompletedPending(receipts: SignedReviewReceipt[]): SignedReviewReceipt | undefined {
  const completed = receipts.filter((item) => item.run_status === "completed");
  const gateOnly = completed.filter((item) => item.gate_only === true);
  const full = completed.filter((item) => item.gate_only !== true);
  if (
    new Set(full.map((item) => item.signature)).size > 1 ||
    new Set(gateOnly.map((item) => item.signature)).size > 1 ||
    (full.length > 0 &&
      gateOnly.length > 0 &&
      JSON.stringify(full[0]!.gate) !== JSON.stringify(gateOnly[0]!.gate))
  ) {
    throw new Error("conflicting completed pending reviews");
  }
  return full[0] ?? gateOnly[0];
}

export function selectPendingReceipt(
  pending: string,
  staged: string[],
  key: Buffer,
  runId: string,
): SignedReviewReceipt {
  const receipts = [pending, ...staged].map(
    (content) => JSON.parse(content) as SignedReviewReceipt,
  );
  validatePendingIdentities(receipts, key, runId);
  const reviewed = selectReviewedPending(receipts);
  return selectCompletedPending(receipts) ?? reviewed ?? receipts[0]!;
}

export function assessUnknownPending(
  signed: SignedReviewReceipt,
  pending: string,
  context: {
    transaction: ReviewTransaction;
    claim: RecoveryClaim;
    key: Buffer;
    note?: string;
    acknowledge: boolean;
  },
): { signed: SignedReviewReceipt; pending: string } {
  assertReviewWritable(context.transaction.root, "review-interruption-assessment");
  if (signed.run_status !== "interrupted" || signed.interruption_disposition === "risk-accepted") {
    return { signed, pending };
  }
  const note = context.note?.trim();
  if (!context.acknowledge || !note || note.length < 10 || note.length > 2000) {
    throw new Error(
      `Review result is unknown for run ${context.transaction.runId} at ${context.transaction.dir}. Inspect the evidence. To accept the remaining unknown risk, use --acknowledge-unknown and --interruption-review with 10 to 2000 characters. The review remains locked until then.`,
    );
  }
  const { signature: _signature, sig_alg: _algorithm, ...body } = signed;
  const assessed = signReviewReceipt(
    { ...body, interruption_review: note, interruption_disposition: "risk-accepted" },
    context.key,
  );
  const content = JSON.stringify(assessed) + "\n";
  writeRecoveryPending(context.transaction, context.claim, content);
  return { signed: assessed, pending: content };
}
