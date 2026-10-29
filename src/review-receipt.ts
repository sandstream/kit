/** Signed evidence for one pull request head. This module has no GitHub or file side effects. */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { ProtectedClass } from "./review-protected-paths.js";

export interface ReviewReceiptInput {
  repo: string;
  pr: number;
  localHead: string;
  remoteHead: string;
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
  schema: "kit-pr-review-receipt/v1";
  repo: string;
  pr: number;
  head: string;
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

export function buildReviewReceipt(input: ReviewReceiptInput): ReviewReceipt {
  if (!/^[a-f0-9]{40}$/.test(input.localHead) || input.localHead !== input.remoteHead) {
    throw new Error("pull request head does not match the local commit");
  }
  if (!/^[^/\s]+\/[^/\s]+$/.test(input.repo) || !Number.isSafeInteger(input.pr) || input.pr < 1) {
    throw new Error("invalid pull request identity");
  }
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
  return {
    schema: "kit-pr-review-receipt/v1",
    repo: input.repo,
    pr: input.pr,
    head: input.localHead,
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
    evidence_issues: evidenceIssues,
  };
}

export function signReviewReceipt(receipt: ReviewReceipt, key: Buffer): SignedReviewReceipt {
  const body = { ...receipt, sig_alg: "hmac-sha256" as const };
  const signature = createHmac("sha256", key).update(JSON.stringify(body)).digest("base64");
  return { ...body, signature };
}

export function verifyReviewReceipt(
  receipt: SignedReviewReceipt,
  key: Buffer,
  expectedHead: string,
): { ok: boolean; reason: string } {
  if (typeof receipt !== "object" || receipt === null) {
    return { ok: false, reason: "invalid review receipt" };
  }
  if (receipt.schema !== "kit-pr-review-receipt/v1" || receipt.sig_alg !== "hmac-sha256") {
    return { ok: false, reason: "unsupported receipt schema or signature algorithm" };
  }
  if (receipt.head !== expectedHead) return { ok: false, reason: "receipt head is stale" };
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
