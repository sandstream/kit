/** Parse GitHub PR evidence without accepting a truncated result as complete. */
import type { ReviewReceiptInput } from "./review-receipt.js";

type RecordValue = Record<string, unknown>;

function record(value: unknown, label: string): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`invalid ${label}`);
  }
  return value as RecordValue;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`invalid ${label}`);
  return value;
}

function parseJson(json: string): RecordValue {
  return record(JSON.parse(json) as unknown, "GitHub response");
}

export interface GitHubPrEvidence {
  number: number;
  head: string;
  changedPaths: string[];
  checks: ReviewReceiptInput["checks"];
}

export function parseGitHubPrView(json: string): GitHubPrEvidence {
  const view = parseJson(json);
  const number = view.number;
  const head = string(view.headRefOid, "PR head");
  if (!Number.isSafeInteger(number) || (number as number) < 1 || !/^[a-f0-9]{40}$/.test(head)) {
    throw new Error("invalid PR number or head");
  }
  const files = view.files;
  if (!Array.isArray(files) || !Number.isSafeInteger(view.changedFiles)) {
    throw new Error("invalid PR changed-file list");
  }
  if (files.length !== view.changedFiles) throw new Error("incomplete PR changed-file list");
  const changedPaths = files.map((file) => string(record(file, "PR file").path, "PR path"));
  const rollup = view.statusCheckRollup;
  if (rollup !== null && !Array.isArray(rollup)) throw new Error("invalid CI check list");
  const checks: ReviewReceiptInput["checks"] = (rollup ?? []).map((raw: unknown) => {
    const check = record(raw, "CI check");
    if (check.__typename === "CheckRun") {
      return {
        name: string(check.name, "check name"),
        status: string(check.status, "check status"),
        conclusion: check.conclusion === null ? "" : string(check.conclusion, "check conclusion"),
        url: check.detailsUrl === null ? "" : string(check.detailsUrl, "check URL"),
      };
    }
    if (check.__typename === "StatusContext") {
      const state = string(check.state, "status context state");
      return {
        name: string(check.context, "status context name"),
        status: state,
        conclusion: state,
        url: check.targetUrl === null ? "" : string(check.targetUrl, "status context URL"),
      };
    }
    throw new Error("unknown CI check type");
  });
  return { number: number as number, head, changedPaths, checks };
}

export function parseGitHubReviewThreads(json: string): ReviewReceiptInput["threads"] {
  const response = parseJson(json);
  const data = record(response.data, "GitHub data");
  const repo = record(data.repository, "GitHub repository");
  const pr = record(repo.pullRequest, "GitHub pull request");
  const connection = record(pr.reviewThreads, "review threads");
  const page = record(connection.pageInfo, "review thread page");
  const nodes = connection.nodes;
  if (!Array.isArray(nodes) || !Number.isSafeInteger(connection.totalCount)) {
    throw new Error("invalid review threads");
  }
  if (page.hasNextPage !== false || nodes.length !== connection.totalCount) {
    throw new Error("incomplete review threads");
  }
  return nodes.map((raw: unknown) => {
    const thread = record(raw, "review thread");
    const comments = record(thread.comments, "review comments");
    const commentsPage = record(comments.pageInfo, "review comment page");
    if (commentsPage.hasNextPage !== false || !Array.isArray(comments.nodes)) {
      throw new Error("incomplete review comments");
    }
    const resolvedBy = thread.resolvedBy;
    if (thread.isResolved !== true && thread.isResolved !== false) {
      throw new Error("invalid review thread status");
    }
    if (thread.line !== null && !Number.isSafeInteger(thread.line)) {
      throw new Error("invalid review thread line");
    }
    return {
      id: string(thread.id, "review thread id"),
      path: string(thread.path, "review thread path"),
      line: thread.line as number | null,
      resolved: thread.isResolved,
      resolvedBy:
        resolvedBy === null ? null : string(record(resolvedBy, "resolver").login, "resolver login"),
      comments: comments.nodes.map((rawComment: unknown) => {
        const comment = record(rawComment, "review comment");
        return {
          url: string(comment.url, "comment URL"),
          body: string(comment.body, "comment body"),
        };
      }),
    };
  });
}
