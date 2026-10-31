/** Collect and store a signed receipt for the exact pull request head. */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hostname } from "node:os";
import { getAuditAnchorKey, tryReadAuditAnchorKey } from "./audit-anchor.js";
import {
  assertPrRefsUnchanged,
  collectPrProtectedPaths,
  readPrRefs,
  type PrRefs,
} from "./review-protected-paths-github.js";
import { parseGitHubPrView, parseGitHubReviewThreads } from "./review-receipt-github.js";
import { assertNoRecoveryArtifacts } from "./review-receipt-artifacts.js";
import { cleanReviewWorktree, REVIEW_RECEIPT_FILE } from "./review-receipt-worktree.js";
export { REVIEW_RECEIPT_FILE } from "./review-receipt-worktree.js";
import {
  persistHistory,
  readReceipt,
  readFailedReviewSummary,
} from "./review-receipt-history-io.js";
export {
  countFailedReviewReceipts,
  readFailedReviewRuns,
  readFailedReviewSummary,
  REVIEW_RECEIPT_HISTORY_FILE,
} from "./review-receipt-history-io.js";
import {
  assertReviewOwner,
  assertReviewReadStamp,
  claimReviewRecovery,
  finishReviewTransaction,
  loadReviewTransaction,
  markReviewStarted,
  readReviewPending,
  readReviewStagedPending,
  releaseReviewRecovery,
  reviewReadStamp,
  reviewStarted,
  writeReviewPending,
  type RecoveryClaim,
  type ReviewTransaction,
} from "./review-receipt-transaction.js";
import { isReadOnlyMode, refuseWrite } from "./read-only-mode.js";
import {
  buildReviewReceipt,
  signReviewReceipt,
  verifyReviewReceipt,
  type ReviewReceipt,
  type ReviewReceiptInput,
  type SignedReviewReceipt,
} from "./review-receipt.js";

export type ReadCommand = (command: string, args: string[], cwd: string) => string;

const REVIEW_THREADS_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){totalCount pageInfo{hasNextPage} nodes{id isResolved path line resolvedBy{login} comments(first:100){pageInfo{hasNextPage} nodes{url body}}}}}}}`;
const PR_VIEW_FIELDS = "number,headRefOid,changedFiles,files,statusCheckRollup";

export function defaultReadCommand(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function gitHead(root: string, run: ReadCommand): string {
  const head = run("git", ["rev-parse", "HEAD"], root).trim();
  if (!/^[a-f0-9]{40}$/.test(head)) throw new Error("invalid local commit");
  return head;
}

function prEvidence(root: string, run: ReadCommand) {
  return parseGitHubPrView(run("gh", ["pr", "view", "--json", PR_VIEW_FIELDS], root));
}

export interface ReviewSnapshot {
  root: string;
  repo: string;
  pr: number;
  head: string;
  refs: PrRefs;
}

/** Capture the source and PR identity before any review stages run. */
export function captureReviewSnapshot(
  cwd: string,
  run: ReadCommand = defaultReadCommand,
): ReviewSnapshot {
  const root = resolve(run("git", ["rev-parse", "--show-toplevel"], cwd).trim());
  const stamp = reviewReadStamp(root, run);
  cleanReviewWorktree(root, run);
  const head = gitHead(root, run);
  const repoValue = JSON.parse(run("gh", ["repo", "view", "--json", "nameWithOwner"], root)) as {
    nameWithOwner?: unknown;
  };
  if (
    typeof repoValue.nameWithOwner !== "string" ||
    !/^[^/\s]+\/[^/\s]+$/.test(repoValue.nameWithOwner)
  ) {
    throw new Error("invalid GitHub repository identity");
  }
  const repo = repoValue.nameWithOwner;
  const pr = prEvidence(root, run);
  const refs = readPrRefs(root, repo, pr.number, run);
  if (pr.head !== head || refs.head !== head)
    throw new Error("pull request head changed before review");
  const snapshot = { root, repo, pr: pr.number, head, refs };
  assertReviewSnapshot(snapshot, run);
  assertReviewReadStamp(root, run, stamp);
  return snapshot;
}

export function assertReviewSnapshot(
  snapshot: ReviewSnapshot,
  run: ReadCommand = defaultReadCommand,
): void {
  const root = resolve(run("git", ["rev-parse", "--show-toplevel"], snapshot.root).trim());
  if (root !== snapshot.root) throw new Error("review root changed during review");
  cleanReviewWorktree(root, run);
  if (gitHead(root, run) !== snapshot.head) throw new Error("local commit changed during review");
  const repoValue = JSON.parse(run("gh", ["repo", "view", "--json", "nameWithOwner"], root)) as {
    nameWithOwner?: unknown;
  };
  const pr = prEvidence(root, run);
  if (
    repoValue.nameWithOwner !== snapshot.repo ||
    pr.number !== snapshot.pr ||
    pr.head !== snapshot.head
  ) {
    throw new Error("pull request changed during review");
  }
  assertPrRefsUnchanged(snapshot.refs, root, snapshot.repo, run);
}

export function collectReviewReceipt(
  cwd: string,
  gate: ReviewReceiptInput["gate"],
  run: ReadCommand = defaultReadCommand,
  createdAt = new Date().toISOString(),
  runId?: string,
): ReviewReceipt {
  const root = resolve(run("git", ["rev-parse", "--show-toplevel"], cwd).trim());
  cleanReviewWorktree(root, run);
  const localHead = gitHead(root, run);
  const repoResponse = JSON.parse(run("gh", ["repo", "view", "--json", "nameWithOwner"], root)) as {
    nameWithOwner?: unknown;
  };
  const repo = repoResponse.nameWithOwner;
  if (typeof repo !== "string") throw new Error("invalid GitHub repository identity");
  const pr = prEvidence(root, run);
  if (pr.head !== localHead) throw new Error("pull request head does not match the local commit");
  const [owner, name] = repo.split("/");
  if (!owner || !name) throw new Error("invalid GitHub repository identity");
  const threads = parseGitHubReviewThreads(
    run(
      "gh",
      [
        "api",
        "graphql",
        "-F",
        `owner=${owner}`,
        "-F",
        `name=${name}`,
        "-F",
        `number=${pr.number}`,
        "-f",
        `query=${REVIEW_THREADS_QUERY}`,
      ],
      root,
    ),
  );
  const { refs, protectedPaths } = collectPrProtectedPaths(
    root,
    { repo, number: pr.number, head: localHead },
    pr.changedPaths,
    run,
  );

  // Refuse a receipt if the branch or PR moved while evidence was collected.
  cleanReviewWorktree(root, run);
  if (gitHead(root, run) !== localHead || prEvidence(root, run).head !== localHead) {
    throw new Error("pull request head changed during receipt collection");
  }
  assertPrRefsUnchanged(refs, root, repo, run);
  return buildReviewReceipt({
    repo,
    pr: pr.number,
    localHead,
    remoteHead: pr.head,
    baseBranch: refs.baseName,
    baseHead: refs.base,
    policyBranch: refs.defaultName,
    policyHead: refs.defaultHead,
    runId,
    createdAt,
    gate,
    checks: pr.checks,
    threads,
    changedPaths: pr.changedPaths,
    protectedPaths,
  });
}

/** Persist an interruption record before starting the review stages. */
export async function prepareReviewReceipt(
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
  const key = await getAuditAnchorKey();
  assertReviewSnapshot(snapshot, run);
  writeReviewPending(transaction, JSON.stringify(signReviewReceipt(receipt, key)) + "\n");
  markReviewStarted(transaction);
}

function writeCurrentReceipt(
  root: string,
  signed: SignedReviewReceipt,
  afterTempWrite?: (temp: string) => void,
): string {
  const path = join(root, REVIEW_RECEIPT_FILE);
  const temp = join(root, `${REVIEW_RECEIPT_FILE}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeFileSync(temp, JSON.stringify(signed, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    afterTempWrite?.(temp);
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
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

export async function writeReviewReceipt(
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
  if (resolve(run("git", ["rev-parse", "--show-toplevel"], cwd).trim()) !== snapshot.root) {
    throw new Error("review root changed during review");
  }
  assertReviewSnapshot(snapshot, run);
  const receipt = collectReviewReceipt(cwd, gate, run, undefined, transaction.runId);
  const key = await getAuditAnchorKey();
  validatePreparedPending(transaction, snapshot, key);
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

function selectPendingReceipt(
  pending: string,
  staged: string[],
  key: Buffer,
  runId: string,
): SignedReviewReceipt {
  const receipts = [pending, ...staged].map(
    (content) => JSON.parse(content) as SignedReviewReceipt,
  );
  for (const signed of receipts) {
    if (!verifyReviewReceipt(signed, key, signed.head).ok || signed.run_id !== runId) {
      throw new Error("pending review signature or identity is invalid");
    }
    const first = receipts[0]!;
    if (
      signed.repo !== first.repo ||
      signed.pr !== first.pr ||
      signed.head !== first.head ||
      signed.base_branch !== first.base_branch ||
      signed.base_head !== first.base_head ||
      signed.policy_branch !== first.policy_branch ||
      signed.policy_head !== first.policy_head
    )
      throw new Error("pending review identity changed");
  }
  const completed = receipts.filter((item) => item.run_status === "completed");
  const interrupted = receipts.filter((item) => item.run_status === "interrupted");
  if (new Set(interrupted.map((item) => item.signature)).size > 1) {
    throw new Error("conflicting interrupted pending reviews");
  }
  if (new Set(completed.map((item) => item.signature)).size > 1) {
    throw new Error("conflicting completed pending reviews");
  }
  return completed[0] ?? receipts[0]!;
}

async function recoverBeforeReviewStarted(
  transaction: ReviewTransaction,
  claim: RecoveryClaim,
): Promise<string> {
  const pending = readReviewPending(transaction);
  const staged = readReviewStagedPending(transaction);
  if (pending !== null || staged.length > 0) {
    const key = await tryReadAuditAnchorKey();
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
  }
  finishReviewTransaction(transaction, claim, staged, pending, false);
  return "Review had not started. Run a new review.";
}

async function recoverStartedReview(
  root: string,
  transaction: ReviewTransaction,
  claim: RecoveryClaim,
  run: ReadCommand,
): Promise<string> {
  const pending = readReviewPending(transaction);
  if (pending === null)
    throw new Error("signed pending review is missing; inspect the lock manually");
  const key = await tryReadAuditAnchorKey();
  if (!key) throw new Error("review receipt signing key is unavailable");
  const staged = readReviewStagedPending(transaction);
  const signed = selectPendingReceipt(
    pending,
    staged.map((item) => item.content),
    key,
    transaction.runId,
  );
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
  finishReviewTransaction(transaction, claim, staged, pending, true);
  if (!matches)
    return "Review history recovered, but the pull request or local commit changed. Run a new review.";
  return signed.run_status === "interrupted"
    ? "Interrupted review recorded. Run a new review."
    : "Review receipt and history recovered.";
}

/** Complete an interrupted local transaction after its owner has stopped. */
export async function recoverReviewReceipt(
  cwd: string,
  confirmStopped: boolean,
  run: ReadCommand = defaultReadCommand,
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
      ? await recoverStartedReview(root, transaction, claim, run)
      : await recoverBeforeReviewStarted(transaction, claim);
    finished = true;
    return result;
  } finally {
    if (!finished && existsSync(transaction.dir)) releaseReviewRecovery(claim);
  }
}

async function verifyReceiptHistory(
  root: string,
  receipt: SignedReviewReceipt,
): Promise<string | null> {
  try {
    const history = await readFailedReviewSummary(root, receipt.head, receipt.gate.command);
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
  const key = await tryReadAuditAnchorKey();
  if (!key) return { ok: false, reason: "review receipt signing key is unavailable" };
  const head = gitHead(root, run);
  const signature = verifyReviewReceipt(receipt, key, head);
  if (!signature.ok) return signature;
  if (receipt.run_status === "interrupted") {
    return { ok: false, reason: "review was interrupted; run a new review" };
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
