/** Collect and store a signed receipt for the exact pull request head. */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getAuditAnchorKey, tryReadAuditAnchorKey } from "./audit-anchor.js";
import { classifyProtectedPaths, loadProtectedPathRules } from "./review-protected-paths.js";
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
export type ReadCommand = (command: string, args: string[], cwd: string) => string;

const REVIEW_THREADS_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){totalCount pageInfo{hasNextPage} nodes{id isResolved path line resolvedBy{login} comments(first:100){pageInfo{hasNextPage} nodes{url body}}}}}}}`;
const PR_VIEW_FIELDS = "number,headRefOid,changedFiles,files,statusCheckRollup";

function defaultReadCommand(command: string, args: string[], cwd: string): string {
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
  const protectedPaths = classifyProtectedPaths(pr.changedPaths, loadProtectedPathRules(root));

  // Refuse a receipt if the branch or PR moved while evidence was collected.
  clean(root, run);
  if (gitHead(root, run) !== localHead || prEvidence(root, run).head !== localHead) {
    throw new Error("pull request head changed during receipt collection");
  }
  return buildReviewReceipt({
    repo,
    pr: pr.number,
    localHead,
    remoteHead: pr.head,
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
): Promise<{ path: string; receipt: ReviewReceipt }> {
  if (isReadOnlyMode()) {
    const refusal = await refuseWrite("review-receipt", {}, { cwd });
    throw new Error(refusal.reason);
  }
  const receipt = collectReviewReceipt(cwd, gate, run);
  const key = await getAuditAnchorKey();
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
  return { path, receipt };
}

export async function verifyReviewReceiptFile(
  cwd: string,
  file = REVIEW_RECEIPT_FILE,
  run: ReadCommand = defaultReadCommand,
): Promise<{ ok: boolean; reason: string }> {
  const root = resolve(run("git", ["rev-parse", "--show-toplevel"], cwd).trim());
  clean(root, run);
  const path = resolve(root, file);
  if (statSync(path).size > 16 * 1024 * 1024) {
    return { ok: false, reason: "review receipt is too large" };
  }
  const json = readFileSync(path, "utf8");
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
  return signature;
}
