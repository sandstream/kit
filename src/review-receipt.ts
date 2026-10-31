/** Signed evidence for one pull request head. This module has no GitHub or file side effects. */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { ProtectedClass } from "./review-protected-paths.js";

export interface ReviewReceiptInput {
  repo: string;
  pr: number;
  localHead: string;
  remoteHead: string;
  baseBranch: string;
  baseHead: string;
  policyBranch: string;
  policyHead: string;
  createdAt: string;
  gate: { command: string; exitCode: number; stdout: string; stderr: string; failures?: string[] };
  checks: { name: string; status: string; conclusion: string; url: string }[];
  threads: {
    id: string;
    path: string;
    line: number | null;
    resolved: boolean;
    resolvedBy: string | null;
    comments: { url: string; body: string }[];
  }[];
  changedPaths: string[];
  protectedPaths: { path: string; classes: ProtectedClass[] }[];
}

export interface ReviewReceipt {
  schema: "kit-pr-review-receipt/v2";
  repo: string;
  pr: number;
  head: string;
  base_branch: string;
  base_head: string;
  policy_branch: string;
  policy_head: string;
  created_at: string;
  gate: { command: string; exit_code: number; output_sha256: string; failures?: string[] };
  checks: { name: string; status: string; conclusion: string; url: string }[];
  review_threads: {
    id: string;
    path: string;
    line: number | null;
    status: "open" | "resolved";
    resolved_by: string | null;
    comments: { url: string; body_sha256: string }[];
  }[];
  changed_paths: string[];
  protected_paths: { path: string; classes: ProtectedClass[] }[];
  evidence_issues: string[];
}

export interface SignedReviewReceipt extends ReviewReceipt {
  sig_alg: "hmac-sha256";
  signature: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validateReceiptInput(input: ReviewReceiptInput): void {
  if (!/^[a-f0-9]{40}$/.test(input.localHead) || input.localHead !== input.remoteHead) {
    throw new Error("pull request head does not match the local commit");
  }
  if (
    !input.baseBranch.trim() ||
    !/^[a-f0-9]{40}$/.test(input.baseHead) ||
    !input.policyBranch.trim() ||
    !/^[a-f0-9]{40}$/.test(input.policyHead)
  ) {
    throw new Error("invalid pull request base");
  }
  if (!/^[^/\s]+\/[^/\s]+$/.test(input.repo) || !Number.isSafeInteger(input.pr) || input.pr < 1) {
    throw new Error("invalid pull request identity");
  }
}

function receiptEvidenceIssues(input: ReviewReceiptInput): string[] {
  const evidenceIssues: string[] = [];
  if (input.gate.exitCode !== 0) evidenceIssues.push("local review failed");
  if (input.checks.length === 0) evidenceIssues.push("no CI checks were returned");
  for (const check of input.checks) {
    if (!["SUCCESS", "NEUTRAL", "SKIPPED"].includes(check.conclusion)) {
      evidenceIssues.push(`CI check is not complete and successful: ${check.name}`);
    }
  }
  if (input.threads.some((thread) => !thread.resolved)) {
    evidenceIssues.push("unresolved GitHub review threads exist");
  }
  return evidenceIssues;
}

export function buildReviewReceipt(input: ReviewReceiptInput): ReviewReceipt {
  validateReceiptInput(input);
  return {
    schema: "kit-pr-review-receipt/v2",
    repo: input.repo,
    pr: input.pr,
    head: input.localHead,
    base_branch: input.baseBranch,
    base_head: input.baseHead,
    policy_branch: input.policyBranch,
    policy_head: input.policyHead,
    created_at: input.createdAt,
    gate: {
      command: input.gate.command,
      exit_code: input.gate.exitCode,
      output_sha256: sha256(
        JSON.stringify({ stdout: input.gate.stdout, stderr: input.gate.stderr }),
      ),
      failures: [...(input.gate.failures ?? [])],
    },
    checks: input.checks.map((check) => ({ ...check })),
    review_threads: input.threads.map((thread) => ({
      id: thread.id,
      path: thread.path,
      line: thread.line,
      status: thread.resolved ? "resolved" : "open",
      resolved_by: thread.resolvedBy,
      comments: thread.comments.map((comment) => ({
        url: comment.url,
        body_sha256: sha256(comment.body),
      })),
    })),
    changed_paths: [...input.changedPaths],
    protected_paths: input.protectedPaths.map((entry) => ({
      path: entry.path,
      classes: [...entry.classes],
    })),
    evidence_issues: receiptEvidenceIssues(input),
  };
}

export function signReviewReceipt(receipt: ReviewReceipt, key: Buffer): SignedReviewReceipt {
  const body = { ...receipt, sig_alg: "hmac-sha256" as const };
  const signature = createHmac("sha256", key).update(JSON.stringify(body)).digest("base64");
  return { ...body, signature };
}

function validReceiptBase(receipt: SignedReviewReceipt): boolean {
  return (
    typeof receipt.base_branch === "string" &&
    !!receipt.base_branch.trim() &&
    typeof receipt.base_head === "string" &&
    /^[a-f0-9]{40}$/.test(receipt.base_head) &&
    typeof receipt.policy_branch === "string" &&
    !!receipt.policy_branch.trim() &&
    typeof receipt.policy_head === "string" &&
    /^[a-f0-9]{40}$/.test(receipt.policy_head)
  );
}

export function verifyReviewReceipt(
  receipt: SignedReviewReceipt,
  key: Buffer,
  expectedHead: string,
  options: { allowLegacy?: boolean } = {},
): { ok: boolean; reason: string } {
  if (typeof receipt !== "object" || receipt === null) {
    return { ok: false, reason: "invalid review receipt" };
  }
  const legacy = (receipt.schema as string) === "kit-pr-review-receipt/v1";
  if (
    (receipt.schema !== "kit-pr-review-receipt/v2" && !(legacy && options.allowLegacy)) ||
    receipt.sig_alg !== "hmac-sha256"
  ) {
    return { ok: false, reason: "unsupported receipt schema or signature algorithm" };
  }
  if (receipt.head !== expectedHead) return { ok: false, reason: "receipt head is stale" };
  if (!legacy && !validReceiptBase(receipt)) {
    return { ok: false, reason: "receipt base is missing or invalid" };
  }
  const { signature, ...body } = receipt;
  if (typeof signature !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(signature)) {
    return { ok: false, reason: "receipt signature is invalid" };
  }
  const actual = Buffer.from(signature, "base64");
  const expected = createHmac("sha256", key).update(JSON.stringify(body)).digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return { ok: false, reason: "receipt signature is invalid" };
  }
  return { ok: true, reason: "receipt signature and head match" };
}
