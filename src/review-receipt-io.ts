/** Collect and store a signed receipt for the exact pull request head. */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { hostname } from "node:os";
import { getAuditAnchorKey, tryReadProtectedAuditAnchorKey } from "./audit-anchor.js";
import { assertPrRefsUnchanged, readPrRefs, type PrRefs } from "./review-protected-paths-github.js";
import {
  assertReviewSnapshot,
  collectReviewReceipt,
  defaultReadCommand,
  gitHead,
  prEvidence,
  type ReadCommand,
  type ReviewSnapshot,
} from "./review-receipt-evidence.js";
export {
  assertReviewSnapshot,
  captureReviewSnapshot,
  collectReviewReceipt,
  defaultReadCommand,
} from "./review-receipt-evidence.js";
export type { ReadCommand, ReviewSnapshot } from "./review-receipt-evidence.js";
export { verifyReviewReceiptFile } from "./review-receipt-verify.js";
import { assertNoRecoveryArtifacts } from "./review-receipt-artifacts.js";
import { publishReviewReceipt } from "./review-receipt-publish.js";
import { assessUnknownPending, selectPendingReceipt } from "./review-receipt-pending.js";
import { cleanReviewWorktree } from "./review-receipt-worktree.js";
export { REVIEW_RECEIPT_FILE } from "./review-receipt-worktree.js";
import {
  persistHistory,
  countFailedReviewReceipts,
  readReceipt,
  readHistory,
  unresolvedInterruptions,
} from "./review-receipt-history-io.js";
export {
  countFailedReviewReceipts,
  readFailedReviewRuns,
  readFailedReviewSummary,
  REVIEW_RECEIPT_HISTORY_FILE,
} from "./review-receipt-history-io.js";
import {
  assertReviewOwner,
  beginReviewTransaction,
  claimReviewRecovery,
  finishReviewTransaction,
  loadReviewTransaction,
  markReviewStarted,
  readReviewPending,
  readReviewStagedPending,
  releaseReviewRecovery,
  reviewStarted,
  writeReviewPending,
  type RecoveryClaim,
  type ReviewTransaction,
} from "./review-receipt-transaction.js";
import { isReadOnlyMode, refuseWrite } from "./read-only-mode.js";
import { assertReviewWritable, withReviewWrite } from "./review-receipt-write-guard.js";
import {
  buildReviewReceipt,
  signReviewReceipt,
  verifyReviewReceipt,
  type ReviewReceipt,
  type ReviewReceiptInput,
  type SignedReviewReceipt,
} from "./review-receipt.js";

/** Persist an interruption record before starting the review stages. */
async function prepareReviewReceiptImpl(
  snapshot: ReviewSnapshot,
  transaction: ReviewTransaction,
  run: ReadCommand = defaultReadCommand,
): Promise<void> {
  if (transaction.root !== snapshot.root) throw new Error("review transaction root does not match");
  assertReviewOwner(transaction);
  assertReviewSnapshot(snapshot, run);
  const receipt = buildReviewReceipt({
    repo: snapshot.repo,
    pr: snapshot.pr,
    localHead: snapshot.head,
    remoteHead: snapshot.head,
    baseBranch: snapshot.refs.baseName,
    baseHead: snapshot.refs.base,
    policyBranch: snapshot.refs.defaultName,
    policyHead: snapshot.refs.defaultHead,
    runId: transaction.runId,
    runStatus: "interrupted",
    createdAt: new Date().toISOString(),
    gate: {
      command: "kit review --receipt",
      exitCode: 1,
      stdout: "",
      stderr: "",
      failures: ["Review interrupted; result unavailable. Run a new review."],
    },
    checks: [],
    threads: [],
    changedPaths: [],
    protectedPaths: [],
  });
  const key = await getAuditAnchorKey(undefined, () =>
    assertReviewWritable(snapshot.root, "review-prepare-receipt"),
  );
  assertReviewSnapshot(snapshot, run);
  writeReviewPending(transaction, JSON.stringify(signReviewReceipt(receipt, key)) + "\n");
  markReviewStarted(transaction);
}

function writeCurrentReceipt(
  root: string,
  signed: SignedReviewReceipt,
  afterTempWrite?: (temp: string) => void,
): string {
  const path = publishReviewReceipt(root, JSON.stringify(signed, null, 2) + "\n", {
    afterTempWrite,
  });
  const saved = readReceipt(path);
  if (saved === null || JSON.stringify(JSON.parse(saved) as unknown) !== JSON.stringify(signed)) {
    throw new Error("review receipt did not retain the signed run");
  }
  return path;
}

function validatePreparedPending(
  transaction: ReviewTransaction,
  snapshot: ReviewSnapshot,
  key: Buffer,
): void {
  const pending = readReviewPending(transaction);
  if (!reviewStarted(transaction) || pending === null) {
    throw new Error("review transaction was not prepared before the review");
  }
  const prior = JSON.parse(pending) as SignedReviewReceipt;
  if (
    !verifyReviewReceipt(prior, key, prior.head).ok ||
    prior.run_id !== transaction.runId ||
    prior.run_status !== "interrupted" ||
    !receiptMatchesRefs(prior, snapshot.repo, snapshot.refs)
  )
    throw new Error("review transaction pending record is invalid");
}

/** Save the local gate result before output or remote evidence collection. */
async function recordReviewGateImpl(
  snapshot: ReviewSnapshot,
  transaction: ReviewTransaction,
  gate: ReviewReceiptInput["gate"],
): Promise<SignedReviewReceipt> {
  if (transaction.root !== snapshot.root) throw new Error("review transaction root does not match");
  assertReviewOwner(transaction);
  const key = await getAuditAnchorKey(undefined, () =>
    assertReviewWritable(snapshot.root, "review-record-gate"),
  );
  validatePreparedPending(transaction, snapshot, key);
  const receipt = buildReviewReceipt({
    repo: snapshot.repo,
    pr: snapshot.pr,
    localHead: snapshot.head,
    remoteHead: snapshot.head,
    baseBranch: snapshot.refs.baseName,
    baseHead: snapshot.refs.base,
    policyBranch: snapshot.refs.defaultName,
    policyHead: snapshot.refs.defaultHead,
    runId: transaction.runId,
    createdAt: new Date().toISOString(),
    gate,
    checks: [],
    threads: [],
    changedPaths: [],
    protectedPaths: [],
  });
  receipt.gate_only = true;
  const signed = signReviewReceipt(receipt, key);
  writeReviewPending(transaction, JSON.stringify(signed) + "\n");
  return signed;
}

async function requireRecordedGate(
  snapshot: ReviewSnapshot,
  transaction: ReviewTransaction,
  gate: ReviewReceiptInput["gate"],
): Promise<SignedReviewReceipt> {
  const key = await getAuditAnchorKey(undefined, () =>
    assertReviewWritable(snapshot.root, "review-receipt"),
  );
  let pending = readReviewPending(transaction);
  if (pending === null) throw new Error("review transaction pending record is missing");
  let recorded = JSON.parse(pending) as SignedReviewReceipt;
  if (recorded.run_status === "interrupted") {
    recorded = await recordReviewGate(snapshot, transaction, gate);
    pending = readReviewPending(transaction);
  }
  const expected = buildReviewReceipt({
    repo: snapshot.repo,
    pr: snapshot.pr,
    localHead: snapshot.head,
    remoteHead: snapshot.head,
    baseBranch: snapshot.refs.baseName,
    baseHead: snapshot.refs.base,
    policyBranch: snapshot.refs.defaultName,
    policyHead: snapshot.refs.defaultHead,
    runId: transaction.runId,
    createdAt: recorded.created_at,
    gate,
    checks: [],
    threads: [],
    changedPaths: [],
    protectedPaths: [],
  });
  if (
    !pending ||
    !verifyReviewReceipt(recorded, key, snapshot.head).ok ||
    !recorded.gate_only ||
    recorded.run_id !== transaction.runId ||
    !receiptMatchesRefs(recorded, snapshot.repo, snapshot.refs) ||
    JSON.stringify(recorded.gate) !== JSON.stringify(expected.gate)
  ) {
    throw new Error("signed local gate result is missing or changed");
  }
  return recorded;
}

function assertReceiptMatchesSnapshot(receipt: ReviewReceipt, snapshot: ReviewSnapshot): void {
  if (
    receipt.repo !== snapshot.repo ||
    receipt.pr !== snapshot.pr ||
    receipt.head !== snapshot.head ||
    receipt.base_branch !== snapshot.refs.baseName ||
    receipt.base_head !== snapshot.refs.base ||
    receipt.policy_branch !== snapshot.refs.defaultName ||
    receipt.policy_head !== snapshot.refs.defaultHead
  )
    throw new Error("review receipt identity changed during review");
}

interface ReceiptWriteHooks {
  afterPending?: () => Promise<void>;
  afterHistory?: () => Promise<void>;
  historyPublish?: typeof import("node:fs").linkSync;
  historyWrite?: (fd: number, text: string) => void;
  afterReceiptTemp?: (temp: string) => void;
}

interface ReceiptWriteOptions {
  run?: ReadCommand;
  snapshot?: ReviewSnapshot;
  transaction?: ReviewTransaction;
  hooks?: ReceiptWriteHooks;
}

async function writeReviewReceiptImpl(
  cwd: string,
  gate: ReviewReceiptInput["gate"],
  options: ReceiptWriteOptions = {},
): Promise<{ path: string; receipt: ReviewReceipt }> {
  const { run = defaultReadCommand, snapshot, transaction, hooks = {} } = options;
  if (isReadOnlyMode()) {
    const refusal = await refuseWrite("review-receipt", {}, { cwd });
    throw new Error(refusal.reason);
  }
  if (!snapshot) throw new Error("review receipt requires an identity captured before review");
  if (!transaction || transaction.root !== snapshot.root) {
    throw new Error("review receipt requires an active review transaction");
  }
  assertReviewOwner(transaction);
  await requireRecordedGate(snapshot, transaction, gate);
  if (resolve(run("git", ["rev-parse", "--show-toplevel"], cwd).trim()) !== snapshot.root) {
    throw new Error("review root changed during review");
  }
  assertReviewSnapshot(snapshot, run);
  const receipt = collectReviewReceipt(cwd, gate, run, undefined, transaction.runId);
  const key = await getAuditAnchorKey(undefined, () =>
    assertReviewWritable(snapshot.root, "review-receipt"),
  );
  await requireRecordedGate(snapshot, transaction, gate);
  assertReviewSnapshot(snapshot, run);
  assertReceiptMatchesSnapshot(receipt, snapshot);
  const signed = signReviewReceipt(receipt, key);
  const root = resolve(run("git", ["rev-parse", "--show-toplevel"], cwd).trim());
  const pendingContent = JSON.stringify(signed) + "\n";
  writeReviewPending(transaction, pendingContent);
  await hooks.afterPending?.();
  persistHistory(root, signed, key, transaction.dir, {
    publish: hooks.historyPublish,
    write: hooks.historyWrite,
  });
  await hooks.afterHistory?.();
  assertReviewSnapshot(snapshot, run);
  const path = writeCurrentReceipt(root, signed, hooks.afterReceiptTemp);
  assertReviewSnapshot(snapshot, run);
  finishReviewTransaction(transaction, undefined, [], pendingContent, true);
  return { path, receipt };
}

function assertTransactionStopped(transaction: ReviewTransaction): void {
  if (transaction.host !== hostname())
    throw new Error("review owner is on another host; inspect manually");
  try {
    process.kill(transaction.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    throw new Error("cannot establish whether the review owner is stopped", { cause: error });
  }
  throw new Error("the review owner is still running; wait for it to finish");
}

function receiptMatchesRefs(signed: SignedReviewReceipt, repo: string, refs: PrRefs): boolean {
  return (
    signed.repo === repo &&
    signed.pr === refs.number &&
    signed.head === refs.head &&
    signed.base_branch === refs.baseName &&
    signed.base_head === refs.base &&
    signed.policy_branch === refs.defaultName &&
    signed.policy_head === refs.defaultHead
  );
}

async function recoverBeforeReviewStarted(
  transaction: ReviewTransaction,
  claim: RecoveryClaim,
): Promise<string> {
  const pending = readReviewPending(transaction);
  const staged = readReviewStagedPending(transaction);
  if (pending !== null || staged.length > 0) {
    const key = await tryReadProtectedAuditAnchorKey();
    if (!key) throw new Error("review receipt signing key is unavailable");
    const first = pending ?? staged[0]!.content;
    const others = pending === null ? staged.slice(1) : staged;
    const signed = selectPendingReceipt(
      first,
      others.map((item) => item.content),
      key,
      transaction.runId,
    );
    if (signed.run_status !== "interrupted") throw new Error("review start marker is missing");
    if (signed.resolves_run_id) {
      persistHistory(transaction.root, signed, key, transaction.dir);
      finishReviewTransaction(transaction, claim, staged, pending, false);
      return "Human assessment recorded for the interrupted review.";
    }
  }
  finishReviewTransaction(transaction, claim, staged, pending, false);
  return "Review had not started. Run a new review.";
}

/** Record a human decision for an older interrupted run already in history. */
async function resolveReviewInterruptionImpl(
  cwd: string,
  runId: string,
  note: string | undefined,
  acknowledge: boolean,
  run: ReadCommand = defaultReadCommand,
): Promise<string> {
  if (isReadOnlyMode()) {
    const refusal = await refuseWrite("review-resolve-interruption", {}, { cwd });
    throw new Error(refusal.reason);
  }
  const review = note?.trim();
  if (
    !/^[a-f0-9]{32}$/.test(runId) ||
    !acknowledge ||
    !review ||
    review.length < 10 ||
    review.length > 2000
  )
    throw new Error(
      "provide a run id, --acknowledge-unknown, and --interruption-review with 10 to 2000 characters",
    );
  const root = resolve(run("git", ["rev-parse", "--show-toplevel"], cwd).trim());
  const transaction = beginReviewTransaction(root, run);
  let preserve = false;
  try {
    cleanReviewWorktree(root, run);
    const key = await tryReadProtectedAuditAnchorKey();
    if (!key) throw new Error("review receipt signing key is unavailable");
    const history = readHistory(root, key, transaction.dir);
    const original = unresolvedInterruptions(history).find((item) => item.run_id === runId);
    if (!original) throw new Error(`unresolved interrupted run ${runId} was not found`);
    countFailedReviewReceipts(history, key, original.head, original.gate.command);
    const repo = JSON.parse(run("gh", ["repo", "view", "--json", "nameWithOwner"], root)) as {
      nameWithOwner?: unknown;
    };
    if (repo.nameWithOwner !== original.repo || prEvidence(root, run).number !== original.pr)
      throw new Error("interrupted run belongs to a different repository or pull request");
    const { signature: _signature, sig_alg: _algorithm, ...body } = original;
    const resolution = signReviewReceipt(
      {
        ...body,
        run_id: transaction.runId,
        resolves_run_id: original.run_id,
        interruption_disposition: "risk-accepted",
        interruption_review: review,
      },
      key,
    );
    const content = JSON.stringify(resolution) + "\n";
    preserve = true;
    writeReviewPending(transaction, content);
    cleanReviewWorktree(root, run);
    persistHistory(root, resolution, key, transaction.dir);
    finishReviewTransaction(transaction, undefined, [], content, false);
    return `Human assessment recorded for run ${runId} at ${original.head}.`;
  } catch (error) {
    if (!preserve && !isReadOnlyMode()) finishReviewTransaction(transaction);
    throw error;
  }
}

interface RecoveryOptions {
  interruptionReview?: string;
  acknowledgeUnknown?: boolean;
  afterAssessment?: () => void;
}

async function recoverStartedReview(
  root: string,
  transaction: ReviewTransaction,
  claim: RecoveryClaim,
  run: ReadCommand,
  options: RecoveryOptions,
): Promise<string> {
  const pending = readReviewPending(transaction);
  if (pending === null)
    throw new Error("signed pending review is missing; inspect the lock manually");
  const key = await tryReadProtectedAuditAnchorKey();
  if (!key) throw new Error("review receipt signing key is unavailable");
  const staged = readReviewStagedPending(transaction);
  const selected = selectPendingReceipt(
    pending,
    staged.map((item) => item.content),
    key,
    transaction.runId,
  );
  const assessed = assessUnknownPending(selected, pending, {
    transaction,
    claim,
    key,
    note: options.interruptionReview,
    acknowledge: options.acknowledgeUnknown ?? false,
  });
  options.afterAssessment?.();
  const signed = assessed.signed;
  persistHistory(root, signed, key, transaction.dir);
  const repoResponse = JSON.parse(run("gh", ["repo", "view", "--json", "nameWithOwner"], root)) as {
    nameWithOwner?: unknown;
  };
  if (typeof repoResponse.nameWithOwner !== "string")
    throw new Error("invalid GitHub repository identity");
  const current = prEvidence(root, run);
  const refs = readPrRefs(root, repoResponse.nameWithOwner, current.number, run);
  const matches =
    receiptMatchesRefs(signed, repoResponse.nameWithOwner, refs) &&
    gitHead(root, run) === signed.head;
  cleanReviewWorktree(root, run);
  if (matches) writeCurrentReceipt(root, signed);
  if (matches && gitHead(root, run) !== signed.head) {
    throw new Error("local commit changed during review recovery");
  }
  assertPrRefsUnchanged(refs, root, repoResponse.nameWithOwner, run);
  finishReviewTransaction(transaction, claim, staged, assessed.pending, true);
  if (!matches)
    return "Review history recovered, but the pull request or local commit changed. Run a new review.";
  return signed.run_status === "interrupted"
    ? "Unknown review result and human assessment recorded. Run a new review."
    : signed.gate_only
      ? "Local gate result recorded. Run a new review to collect current PR evidence."
      : "Review receipt and history recovered.";
}

/** Complete an interrupted local transaction after its owner has stopped. */
async function recoverReviewReceiptImpl(
  cwd: string,
  confirmStopped: boolean,
  run: ReadCommand = defaultReadCommand,
  options: RecoveryOptions = {},
): Promise<string> {
  if (isReadOnlyMode()) {
    const refusal = await refuseWrite("review-recover-receipt", {}, { cwd });
    throw new Error(refusal.reason);
  }
  if (!confirmStopped)
    throw new Error("confirm the review process has stopped with --confirm-stopped");
  const root = resolve(run("git", ["rev-parse", "--show-toplevel"], cwd).trim());
  const transaction = loadReviewTransaction(root, run);
  assertTransactionStopped(transaction);
  const claim = claimReviewRecovery(transaction);
  let finished = false;
  try {
    assertNoRecoveryArtifacts(root, transaction.dir);
    cleanReviewWorktree(root, run);
    const result = reviewStarted(transaction)
      ? await recoverStartedReview(root, transaction, claim, run, options)
      : await recoverBeforeReviewStarted(transaction, claim);
    finished = true;
    return result;
  } finally {
    if (!finished && existsSync(transaction.dir) && !isReadOnlyMode()) releaseReviewRecovery(claim);
  }
}

/** Write entry points preserve refusal audit records for synchronous and asynchronous failures. */
export function prepareReviewReceipt(
  snapshot: ReviewSnapshot,
  transaction: ReviewTransaction,
  run: ReadCommand = defaultReadCommand,
): Promise<void> {
  return withReviewWrite(snapshot.root, "review-prepare-receipt", () =>
    prepareReviewReceiptImpl(snapshot, transaction, run),
  );
}

export function recordReviewGate(
  snapshot: ReviewSnapshot,
  transaction: ReviewTransaction,
  gate: ReviewReceiptInput["gate"],
): Promise<SignedReviewReceipt> {
  return withReviewWrite(snapshot.root, "review-record-gate", () =>
    recordReviewGateImpl(snapshot, transaction, gate),
  );
}

export function writeReviewReceipt(
  cwd: string,
  gate: ReviewReceiptInput["gate"],
  options: ReceiptWriteOptions = {},
): Promise<{ path: string; receipt: ReviewReceipt }> {
  return withReviewWrite(cwd, "review-receipt", () => writeReviewReceiptImpl(cwd, gate, options));
}

export function resolveReviewInterruption(
  cwd: string,
  runId: string,
  note: string | undefined,
  acknowledge: boolean,
  run: ReadCommand = defaultReadCommand,
): Promise<string> {
  return withReviewWrite(cwd, "review-resolve-interruption", () =>
    resolveReviewInterruptionImpl(cwd, runId, note, acknowledge, run),
  );
}

export function recoverReviewReceipt(
  cwd: string,
  confirmStopped: boolean,
  run: ReadCommand = defaultReadCommand,
  options: RecoveryOptions = {},
): Promise<string> {
  return withReviewWrite(cwd, "review-recover-receipt", () =>
    recoverReviewReceiptImpl(cwd, confirmStopped, run, options),
  );
}
