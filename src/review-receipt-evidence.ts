/** Collect the Git and GitHub evidence for a review receipt. */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import {
  assertPrRefsUnchanged,
  collectPrProtectedPaths,
  readPrRefs,
  type PrRefs,
} from "./review-protected-paths-github.js";
import { parseGitHubPrView, parseGitHubReviewThreads } from "./review-receipt-github.js";
import { cleanReviewWorktree } from "./review-receipt-worktree.js";
import { assertReviewReadStamp, reviewReadStamp } from "./review-receipt-transaction.js";
import {
  buildReviewReceipt,
  type ReviewReceipt,
  type ReviewReceiptInput,
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

export function gitHead(root: string, run: ReadCommand): string {
  const head = run("git", ["rev-parse", "HEAD"], root).trim();
  if (!/^[a-f0-9]{40}$/.test(head)) throw new Error("invalid local commit");
  return head;
}

export function prEvidence(root: string, run: ReadCommand) {
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
