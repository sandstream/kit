/** Collect and store a signed receipt for the exact pull request head. */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { getAuditAnchorKey, tryReadAuditAnchorKey } from "./audit-anchor.js";
import {
  assertPrRefsUnchanged,
  collectPrProtectedPaths,
  readPrRefs,
  type PrRefs,
} from "./review-protected-paths-github.js";
import { parseGitHubPrView, parseGitHubReviewThreads } from "./review-receipt-github.js";
import { isReadOnlyMode, refuseWrite } from "./read-only-mode.js";
import {
  buildReviewReceipt,
  signReviewReceipt,
  verifyReviewReceipt,
  type ReviewReceipt,
  type ReviewReceiptInput,
  type SignedReviewReceipt,
} from "./review-receipt.js";

export const REVIEW_RECEIPT_FILE = ".kit-review-receipt.json";
export const REVIEW_RECEIPT_HISTORY_FILE = ".kit-review-receipt-history.jsonl";
export type ReadCommand = (command: string, args: string[], cwd: string) => string;

const REVIEW_THREADS_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){totalCount pageInfo{hasNextPage} nodes{id isResolved path line resolvedBy{login} comments(first:100){pageInfo{hasNextPage} nodes{url body}}}}}}}`;
const PR_VIEW_FIELDS = "number,headRefOid,changedFiles,files,statusCheckRollup";
const MAX_RECEIPT_BYTES = 16 * 1024 * 1024;

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

function clean(root: string, run: ReadCommand): void {
  if (run("git", ["status", "--porcelain", "--untracked-files=all"], root).trim()) {
    throw new Error("review receipt requires a clean worktree");
  }
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
  clean(root, run);
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
  return snapshot;
}

export function assertReviewSnapshot(
  snapshot: ReviewSnapshot,
  run: ReadCommand = defaultReadCommand,
): void {
  const root = resolve(run("git", ["rev-parse", "--show-toplevel"], snapshot.root).trim());
  if (root !== snapshot.root) throw new Error("review root changed during review");
  clean(root, run);
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

function readReceipt(path: string): string | null {
  const fd = openSync(path, "r");
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
  for (const receipt of receipts) {
    if (!/^[a-f0-9]{40}$/.test(receipt.head)) throw new Error("invalid receipt history head");
    const verdict = verifyReviewReceipt(receipt, key, receipt.head, { allowLegacy: true });
    if (!verdict.ok) throw new Error(`invalid receipt history signature: ${verdict.reason}`);
    if (receipt.head === head && receipt.gate.command === command && receipt.gate.exit_code !== 0) {
      failures.add(receipt.signature);
    }
  }
  return failures.size;
}

export async function readFailedReviewRuns(
  root: string,
  head: string,
  command: string,
): Promise<number> {
  const path = join(root, REVIEW_RECEIPT_HISTORY_FILE);
  let content: string | null;
  try {
    content = readReceipt(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  if (content === null) throw new Error("review receipt history is too large");
  const lines = content.split("\n").filter(Boolean);
  if (lines.length === 0) return 0;
  const key = await tryReadAuditAnchorKey();
  if (!key) throw new Error("review receipt history signing key is unavailable");
  const receipts = lines.map((line) => JSON.parse(line) as SignedReviewReceipt);
  return countFailedReviewReceipts(receipts, key, head, command);
}

export function collectReviewReceipt(
  cwd: string,
  gate: ReviewReceiptInput["gate"],
  run: ReadCommand = defaultReadCommand,
  createdAt = new Date().toISOString(),
): ReviewReceipt {
  const root = resolve(run("git", ["rev-parse", "--show-toplevel"], cwd).trim());
  clean(root, run);
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
  clean(root, run);
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
    createdAt,
    gate,
    checks: pr.checks,
    threads,
    changedPaths: pr.changedPaths,
    protectedPaths,
  });
}

export async function writeReviewReceipt(
  cwd: string,
  gate: ReviewReceiptInput["gate"],
  run: ReadCommand = defaultReadCommand,
  snapshot?: ReviewSnapshot,
): Promise<{ path: string; receipt: ReviewReceipt }> {
  if (isReadOnlyMode()) {
    const refusal = await refuseWrite("review-receipt", {}, { cwd });
    throw new Error(refusal.reason);
  }
  if (!snapshot) throw new Error("review receipt requires an identity captured before review");
  if (resolve(run("git", ["rev-parse", "--show-toplevel"], cwd).trim()) !== snapshot.root) {
    throw new Error("review root changed during review");
  }
  assertReviewSnapshot(snapshot, run);
  const receipt = collectReviewReceipt(cwd, gate, run);
  const key = await getAuditAnchorKey();
  assertReviewSnapshot(snapshot, run);
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
  const signed = signReviewReceipt(receipt, key);
  const root = resolve(run("git", ["rev-parse", "--show-toplevel"], cwd).trim());
  const path = join(root, REVIEW_RECEIPT_FILE);
  const temp = join(root, `${REVIEW_RECEIPT_FILE}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeFileSync(temp, JSON.stringify(signed, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
  if (gate.exitCode !== 0) {
    appendFileSync(join(root, REVIEW_RECEIPT_HISTORY_FILE), JSON.stringify(signed) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
  }
  return { path, receipt };
}

export async function verifyReviewReceiptFile(
  cwd: string,
  file = REVIEW_RECEIPT_FILE,
  run: ReadCommand = defaultReadCommand,
): Promise<{ ok: boolean; reason: string; receipt?: SignedReviewReceipt }> {
  const root = resolve(run("git", ["rev-parse", "--show-toplevel"], cwd).trim());
  clean(root, run);
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
  return { ...signature, receipt };
}
