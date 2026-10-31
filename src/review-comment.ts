/** Parse versioned independent review comments as untrusted data. */

export const REVIEW_COMMENT_MARKER = "<!-- kit-independent-review:v1 -->";
const SHA = /^[a-f0-9]{40}$/;
const AREAS = ["correctness", "security", "tests", "public-hygiene", "adr"] as const;
const MAX_BODY_LENGTH = 1_000_000;

export function isReviewCommentCandidate(body: string): boolean {
  return body.includes("kit-independent-review:");
}

export interface ExpectedReviewComment {
  repository: string;
  pullRequest: number;
  head: string;
  baseBranch: string;
  mergeBase: string;
}

export interface ReviewCommentFinding {
  severity: string;
  file: string;
  line: number;
  scenario: string;
  evidence: string;
}

export interface ReviewCommentReport {
  repository: string;
  pullRequest: number;
  head: string;
  baseBranch: string;
  baseTip: string;
  mergeBase: string;
  verdict: "pass" | "findings" | "incomplete";
  checks: { area: string; status: "pass" | "issue" | "unverified"; evidence: string }[];
  limits: string[];
  findings: ReviewCommentFinding[];
}

export type ReviewCommentResult =
  | { kind: "unmarked" }
  | { kind: "invalid"; reason: string; report?: ReviewCommentReport }
  | { kind: "stale"; reason: string; report: ReviewCommentReport }
  | { kind: "current"; report: ReviewCommentReport };

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 10_000 &&
    !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
  );
}

function relativePath(value: unknown): value is string {
  return (
    text(value) &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.split("/").some((part) => part === "" || part === "." || part === "..") &&
    !/^[A-Za-z]:/.test(value) &&
    !/[\x00-\x1f\x7f]/.test(value)
  );
}

function checks(value: unknown): ReviewCommentReport["checks"] | null {
  if (!Array.isArray(value) || value.length !== AREAS.length) return null;
  const out: ReviewCommentReport["checks"] = [];
  for (const item of value) {
    const row = object(item);
    if (
      !row ||
      typeof row.area !== "string" ||
      !AREAS.includes(row.area as (typeof AREAS)[number]) ||
      (row.status !== "pass" && row.status !== "issue" && row.status !== "unverified") ||
      !text(row.evidence) ||
      out.some((entry) => entry.area === row.area)
    )
      return null;
    out.push({ area: row.area, status: row.status, evidence: row.evidence });
  }
  return out;
}

function findings(value: unknown): ReviewCommentFinding[] | null {
  if (!Array.isArray(value) || value.length > 1000) return null;
  const out: ReviewCommentFinding[] = [];
  for (const item of value) {
    const row = object(item);
    if (
      !row ||
      !text(row.severity) ||
      !relativePath(row.file) ||
      !Number.isSafeInteger(row.line) ||
      (row.line as number) < 1 ||
      !text(row.scenario) ||
      !text(row.evidence)
    )
      return null;
    out.push({
      severity: row.severity,
      file: row.file,
      line: row.line as number,
      scenario: row.scenario,
      evidence: row.evidence,
    });
  }
  return out;
}

interface RawIdentity extends Record<string, unknown> {
  repository: string;
  pull_request: number;
  base_branch: string;
  base_tip: string;
  base: string;
  head: string;
  verdict: ReviewCommentReport["verdict"];
}

function validIdentity(row: Record<string, unknown>): row is RawIdentity {
  return (
    text(row.repository) &&
    Number.isSafeInteger(row.pull_request) &&
    (row.pull_request as number) > 0 &&
    text(row.base_branch) &&
    typeof row.base_tip === "string" &&
    SHA.test(row.base_tip) &&
    typeof row.base === "string" &&
    SHA.test(row.base) &&
    typeof row.head === "string" &&
    SHA.test(row.head) &&
    (row.verdict === "pass" || row.verdict === "findings" || row.verdict === "incomplete")
  );
}

function consistent(
  verdict: ReviewCommentReport["verdict"],
  parsedChecks: ReviewCommentReport["checks"],
  parsedFindings: ReviewCommentFinding[],
  limits: string[],
): boolean {
  const hasIssue = parsedChecks.some((check) => check.status === "issue");
  const unverified = parsedChecks.some((check) => check.status === "unverified");
  if (hasIssue !== parsedFindings.length > 0 || (unverified && limits.length === 0)) return false;
  if (verdict === "pass") return parsedFindings.length === 0 && limits.length === 0 && !unverified;
  if (verdict === "findings")
    return parsedFindings.length > 0 && limits.length === 0 && !unverified;
  return limits.length > 0 || unverified;
}

function report(value: unknown): ReviewCommentReport | null {
  const row = object(value);
  if (!row || row.schema !== "kit-independent-review/v1" || !validIdentity(row)) return null;
  const parsedChecks = checks(row.checks);
  const parsedFindings = findings(row.findings);
  if (
    !parsedChecks ||
    !parsedFindings ||
    !Array.isArray(row.limits) ||
    row.limits.length > 1000 ||
    !row.limits.every(text)
  )
    return null;
  const limits: string[] = row.limits;
  if (!consistent(row.verdict, parsedChecks, parsedFindings, limits)) return null;
  return {
    repository: row.repository,
    pullRequest: row.pull_request,
    head: row.head,
    baseBranch: row.base_branch,
    baseTip: row.base_tip,
    mergeBase: row.base,
    verdict: row.verdict,
    checks: parsedChecks,
    limits,
    findings: parsedFindings,
  };
}

export function parseReviewComment(
  body: string,
  expected: ExpectedReviewComment,
): ReviewCommentResult {
  if (typeof body !== "string") return { kind: "invalid", reason: "invalid review comment body" };
  if (!isReviewCommentCandidate(body)) return { kind: "unmarked" };
  if (body.length > MAX_BODY_LENGTH)
    return { kind: "invalid", reason: "review comment is too large" };
  const match = /^\s*<!-- kit-independent-review:v1 -->\s*```json\s*\n([\s\S]*?)\n```\s*$/.exec(
    body,
  );
  if (!match) return { kind: "invalid", reason: "invalid review comment format or version" };
  let parsed: ReviewCommentReport | null;
  try {
    parsed = report(JSON.parse(match[1]!) as unknown);
  } catch {
    parsed = null;
  }
  if (!parsed) return { kind: "invalid", reason: "invalid review comment fields" };
  if (
    parsed.repository.toLowerCase() !== expected.repository.toLowerCase() ||
    parsed.pullRequest !== expected.pullRequest
  )
    return { kind: "invalid", reason: "review comment identifies a different pull request" };
  if (parsed.head !== expected.head)
    return { kind: "stale", reason: "review comment is for a different head", report: parsed };
  if (parsed.baseBranch !== expected.baseBranch || parsed.mergeBase !== expected.mergeBase)
    return { kind: "stale", reason: "review comment is for a different base", report: parsed };
  return { kind: "current", report: parsed };
}

export interface ReviewCommentInput {
  id: string;
  url: string;
  author: string;
  authorMissing?: boolean;
  authorType?: string;
  authorAssociation?: string;
  createdAt: string;
  updatedAt: string;
  body: string;
}

export interface SelectedReviewComment {
  comment: ReviewCommentInput;
  result: Exclude<ReviewCommentResult, { kind: "unmarked" }>;
}

function validMetadata(comment: ReviewCommentInput): boolean {
  return (
    /^[1-9][0-9]{0,29}$/.test(comment.id) &&
    text(comment.url) &&
    text(comment.author) &&
    !/[\x00-\x20\x7f]/.test(comment.url) &&
    /^[a-z0-9][a-z0-9-]{0,38}(?:\[bot\])?$/i.test(comment.author) &&
    Number.isFinite(Date.parse(comment.createdAt)) &&
    Number.isFinite(Date.parse(comment.updatedAt))
  );
}

function editedResult(
  result: Exclude<ReviewCommentResult, { kind: "unmarked" }>,
): Extract<ReviewCommentResult, { kind: "invalid" }> {
  const parsedReport =
    result.kind === "current" || result.kind === "stale" ? result.report : undefined;
  return parsedReport
    ? { kind: "invalid", reason: "review comment was edited", report: parsedReport }
    : { kind: "invalid", reason: "review comment was edited" };
}

/** Retain edited comments and findings on the current head across base changes. */
export function selectReviewComments(
  comments: ReviewCommentInput[],
  expected: ExpectedReviewComment,
): SelectedReviewComment[] {
  const latest = new Map<string, SelectedReviewComment>();
  const retained: SelectedReviewComment[] = [];
  const ids = new Set<string>();
  for (const comment of comments) {
    let result = parseReviewComment(comment.body, expected);
    if (result.kind === "unmarked") continue;
    if (!validMetadata(comment)) throw new Error("invalid GitHub comment metadata");
    if (ids.has(comment.id)) throw new Error("duplicate GitHub comment ID");
    ids.add(comment.id);
    if (comment.createdAt !== comment.updatedAt) result = editedResult(result);
    if (
      comment.createdAt !== comment.updatedAt ||
      ((result.kind === "current" || result.kind === "stale") &&
        result.report.head === expected.head &&
        result.report.findings.length > 0)
    )
      retained.push({ comment, result });
    const author = comment.authorMissing
      ? `missing:${comment.id}`
      : `author:${comment.author.toLowerCase()}`;
    const prior = latest.get(author);
    if (!prior || BigInt(comment.id) > BigInt(prior.comment.id))
      latest.set(author, { comment, result });
  }
  const selected = [...latest.values()];
  const selectedIds = new Set(selected.map((entry) => entry.comment.id));
  selected.push(...retained.filter((entry) => !selectedIds.has(entry.comment.id)));
  return selected.sort((a, b) => (BigInt(a.comment.id) < BigInt(b.comment.id) ? -1 : 1));
}
