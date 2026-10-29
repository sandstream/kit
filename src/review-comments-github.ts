/** Read all PR comments and bind independent review reports to current GitHub refs. */
import {
  isReviewCommentCandidate,
  selectReviewComments,
  type ReviewCommentInput,
  type SelectedReviewComment,
} from "./review-comment.js";
import type { ReadCommand } from "./review-receipt-io.js";

const SHA = /^[a-f0-9]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){number headRefOid baseRefName baseRef{target{oid}}}}}`;

type RecordValue = Record<string, unknown>;

function object(value: unknown, label: string): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`invalid ${label}`);
  }
  return value as RecordValue;
}

function requiredText(value: unknown, label: string, max = 1_000): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    /[\x00-\x1f\x7f]/.test(value)
  ) {
    throw new Error(`invalid ${label}`);
  }
  return value;
}

function commit(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA.test(value)) throw new Error(`invalid ${label}`);
  return value;
}

interface PullRequestState {
  head: string;
  baseBranch: string;
  baseTip: string;
}

function parseState(json: string, number: number): PullRequestState {
  const response = object(JSON.parse(json) as unknown, "GitHub response");
  if (response.errors !== undefined) throw new Error("GitHub returned pull request errors");
  const data = object(response.data, "GitHub data");
  const repo = object(data.repository, "GitHub repository");
  const pr = object(repo.pullRequest, "GitHub pull request");
  if (pr.number !== number) throw new Error("pull request identity changed");
  const baseRef = object(pr.baseRef, "pull request base ref");
  const baseTarget = object(baseRef.target, "pull request base target");
  return {
    head: commit(pr.headRefOid, "pull request head"),
    baseBranch: requiredText(pr.baseRefName, "pull request base branch"),
    baseTip: commit(baseTarget.oid, "pull request base tip"),
  };
}

function readState(root: string, repo: string, number: number, run: ReadCommand): PullRequestState {
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
      `number=${number}`,
      "-f",
      `query=${QUERY}`,
    ],
    root,
  );
  return parseState(response, number);
}

function commentUrl(value: unknown): string {
  const url = requiredText(value, "comment URL", 4_096);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("invalid comment URL");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error("invalid comment URL");
  }
  return url;
}

function parseComment(raw: unknown): ReviewCommentInput {
  const item = object(raw, "GitHub comment");
  if (!Number.isSafeInteger(item.id) || (item.id as number) < 1) {
    throw new Error("invalid GitHub comment ID");
  }
  const user = item.user === null ? null : object(item.user, "comment author");
  if (typeof item.body !== "string") throw new Error("invalid GitHub comment body");
  const createdAt = requiredText(item.created_at, "comment creation time");
  const updatedAt = requiredText(item.updated_at, "comment update time");
  if (!Number.isFinite(Date.parse(createdAt)) || !Number.isFinite(Date.parse(updatedAt))) {
    throw new Error("invalid GitHub comment time");
  }
  return {
    id: String(item.id),
    url: commentUrl(item.html_url),
    author: user ? requiredText(user.login, "comment author") : `deleted-user-${item.id}`,
    ...(user
      ? { authorType: requiredText(user.type, "comment author type") }
      : { authorMissing: true }),
    authorAssociation: requiredText(item.author_association, "comment author association"),
    createdAt,
    updatedAt,
    body: item.body,
  };
}

function parseCandidate(raw: unknown): ReviewCommentInput[] {
  const item = object(raw, "GitHub comment");
  if (typeof item.body !== "string") throw new Error("invalid GitHub comment body");
  return isReviewCommentCandidate(item.body) ? [parseComment(item)] : [];
}

function readComments(
  root: string,
  repo: string,
  number: number,
  run: ReadCommand,
): ReviewCommentInput[] {
  const endpoint = `repos/${repo}/issues/${number}/comments?per_page=100`;
  const response: unknown = JSON.parse(run("gh", ["api", "--paginate", "--slurp", endpoint], root));
  if (!Array.isArray(response) || response.length === 0 || !response.every(Array.isArray)) {
    throw new Error("invalid GitHub comment pages");
  }
  return response.flatMap((page: unknown[]) => page.flatMap(parseCandidate));
}

export function collectIndependentReviewComments(
  root: string,
  repo: string,
  prNumber: number,
  expectedHead: string,
  run: ReadCommand,
): SelectedReviewComment[] {
  if (
    !REPOSITORY.test(repo) ||
    repo.split("/").some((part) => part === "." || part === "..") ||
    !Number.isSafeInteger(prNumber) ||
    prNumber < 1 ||
    !SHA.test(expectedHead)
  ) {
    throw new Error("invalid pull request identity");
  }
  const before = readState(root, repo, prNumber, run);
  if (before.head !== expectedHead) throw new Error("pull request head changed");
  const comments = readComments(root, repo, prNumber, run);
  const endpoint = `repos/${repo}/compare/${before.baseTip}...${before.head}`;
  const mergeBase = commit(
    run("gh", ["api", endpoint, "--jq", ".merge_base_commit.sha"], root).trim(),
    "merge base",
  );
  const after = readState(root, repo, prNumber, run);
  if (
    before.head !== after.head ||
    before.baseBranch !== after.baseBranch ||
    before.baseTip !== after.baseTip
  ) {
    throw new Error("pull request head or base changed during comment collection");
  }
  return selectReviewComments(comments, {
    repository: repo,
    pullRequest: prNumber,
    head: expectedHead,
    baseBranch: before.baseBranch,
    mergeBase,
  });
}
