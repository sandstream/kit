/** Collect live pull request evidence and a verified local receipt. */
import { resolve } from "node:path";
import { parseCurrentHumanApproval } from "./escalate-pr-github.js";
import type { PrEscalationEvidence } from "./escalate-pr.js";
import { collectIndependentReviewComments } from "./review-comments-github.js";
import { classifyProtectedPaths, loadProtectedPathRules } from "./review-protected-paths.js";
import {
  parseGitHubPrView,
  parseGitHubReviewThreads,
  type GitHubPrEvidence,
} from "./review-receipt-github.js";
import {
  buildReviewReceipt,
  type ReviewReceipt,
  type ReviewReceiptInput,
} from "./review-receipt.js";
import {
  defaultReadCommand,
  readFailedReviewRuns,
  REVIEW_RECEIPT_FILE,
  verifyReviewReceiptFile,
  type ReadCommand,
} from "./review-receipt-io.js";
import { redactSecrets } from "./utils/redactSecrets.js";

const PR_VIEW_FIELDS = "number,headRefOid,changedFiles,files,statusCheckRollup";
const PR_REVIEW_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){author{login} reviewThreads(first:100){totalCount pageInfo{hasNextPage} nodes{id isResolved path line resolvedBy{login} comments(first:100){pageInfo{hasNextPage} nodes{url body}}}} latestOpinionatedReviews(first:100){totalCount pageInfo{hasNextPage} nodes{author{__typename login} state commit{oid}}}}}}`;

function prView(root: string, run: ReadCommand) {
  return parseGitHubPrView(run("gh", ["pr", "view", "--json", PR_VIEW_FIELDS], root));
}

function errorMessage(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

function sameRecords<T>(left: T[], right: T[]): boolean {
  return (
    JSON.stringify(left.map((entry) => JSON.stringify(entry)).sort()) ===
    JSON.stringify(right.map((entry) => JSON.stringify(entry)).sort())
  );
}

export function receiptMatchesCurrent(
  receipt: ReviewReceipt,
  pr: GitHubPrEvidence,
  threads: ReviewReceiptInput["threads"],
  protectedPaths: ReviewReceiptInput["protectedPaths"],
): boolean {
  const live = buildReviewReceipt({
    repo: receipt.repo,
    pr: pr.number,
    localHead: pr.head,
    remoteHead: pr.head,
    createdAt: receipt.created_at,
    gate: {
      command: receipt.gate.command,
      exitCode: receipt.gate.exit_code,
      stdout: "",
      stderr: "",
    },
    checks: pr.checks,
    threads,
    changedPaths: pr.changedPaths,
    protectedPaths,
  });
  return (
    sameRecords(receipt.checks, live.checks) &&
    sameRecords(receipt.review_threads, live.review_threads) &&
    sameRecords(receipt.changed_paths, live.changed_paths) &&
    sameRecords(receipt.protected_paths, live.protected_paths)
  );
}

function prIdentity(cwd: string, run: ReadCommand) {
  const root = resolve(run("git", ["rev-parse", "--show-toplevel"], cwd).trim());
  const localHead = run("git", ["rev-parse", "HEAD"], root).trim();
  const repoResponse = JSON.parse(run("gh", ["repo", "view", "--json", "nameWithOwner"], root)) as {
    nameWithOwner?: unknown;
  };
  if (
    typeof repoResponse.nameWithOwner !== "string" ||
    !/^[^/\s]+\/[^/\s]+$/.test(repoResponse.nameWithOwner)
  ) {
    throw new Error("invalid GitHub repository identity");
  }
  const repo = repoResponse.nameWithOwner;
  const pr = prView(root, run);
  if (localHead !== pr.head) throw new Error("local commit does not match the PR head");
  return { root, repo, pr };
}

function reviewEvidence(
  root: string,
  repo: string,
  pr: ReturnType<typeof prView>,
  run: ReadCommand,
) {
  const [owner, name] = repo.split("/");
  const response = run(
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
      `query=${PR_REVIEW_QUERY}`,
    ],
    root,
  );
  const rawThreads = parseGitHubReviewThreads(response);
  const threads = rawThreads.map((thread) => {
    const first = thread.comments[0];
    const scenario = redactSecrets(first?.body ?? "See GitHub review thread")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200);
    return {
      path: thread.path,
      line: thread.line,
      url: first?.url ?? `https://github.com/${repo}/pull/${pr.number}`,
      scenario,
      resolved: thread.resolved,
    };
  });
  const humanApproved = parseCurrentHumanApproval(response, pr.head);
  return { threads, rawThreads, humanApproved };
}

async function localReceipt(
  root: string,
  pr: GitHubPrEvidence,
  rawThreads: ReviewReceiptInput["threads"],
  protectedPaths: ReviewReceiptInput["protectedPaths"],
  run: ReadCommand,
) {
  let receiptProblem: string | null = null;
  let historyProblem: string | null = null;
  let gate: PrEscalationEvidence["gate"] = null;
  let failedGateRuns = 0;
  try {
    const verified = await verifyReviewReceiptFile(root, REVIEW_RECEIPT_FILE, run);
    if (!verified.ok || !verified.receipt) {
      receiptProblem = verified.reason;
    } else {
      if (!receiptMatchesCurrent(verified.receipt, pr, rawThreads, protectedPaths)) {
        receiptProblem = "review receipt evidence changed on this PR head";
      }
      const saved = verified.receipt.gate;
      gate = {
        command: saved.command,
        exitCode: saved.exit_code,
        outputSha256: saved.output_sha256,
        failures: saved.failures ?? [],
      };
      try {
        failedGateRuns = await readFailedReviewRuns(root, pr.head, saved.command);
      } catch (error) {
        historyProblem = `review history cannot be verified: ${errorMessage(error)}`;
      }
    }
  } catch (error) {
    receiptProblem =
      (error as NodeJS.ErrnoException).code === "ENOENT"
        ? "review receipt missing for the current PR head"
        : `review receipt unavailable: ${errorMessage(error)}`;
  }
  return { receiptProblem, historyProblem, gate, failedGateRuns };
}

export async function collectPrEvidence(
  cwd: string,
  options: { mergeDenied: boolean },
  run: ReadCommand = defaultReadCommand,
): Promise<PrEscalationEvidence> {
  const { root, repo, pr } = prIdentity(cwd, run);
  const { threads, rawThreads, humanApproved } = reviewEvidence(root, repo, pr, run);
  const protectedPaths = classifyProtectedPaths(pr.changedPaths, loadProtectedPathRules(root));
  let reviewComments: PrEscalationEvidence["reviewComments"];
  let reviewCommentProblem: string | null = null;
  try {
    reviewComments = collectIndependentReviewComments(root, repo, pr.number, pr.head, run);
  } catch (error) {
    reviewCommentProblem = `review comments unavailable: ${errorMessage(error)}`;
  }
  const current = prView(root, run);
  const receipt = await localReceipt(root, current, rawThreads, protectedPaths, run);
  if (
    run("git", ["rev-parse", "HEAD"], root).trim() !== pr.head ||
    current.head !== pr.head ||
    current.number !== pr.number
  ) {
    throw new Error("PR head changed while collecting escalation evidence");
  }
  return {
    repo,
    pr: pr.number,
    head: pr.head,
    ...receipt,
    checks: current.checks,
    threads,
    protectedPaths,
    reviewComments,
    reviewCommentProblem,
    humanApproved,
    mergeDenied: options.mergeDenied,
  };
}
