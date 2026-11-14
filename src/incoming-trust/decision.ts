import {
  incomingApproval,
  incomingAuthority,
  incomingContext,
  incomingTimestamp,
  incomingVerification,
} from "./decision-schema.js";
import {
  incomingAuthorityKeys,
  incomingVerificationDigest,
  sameIncomingContext,
  validIncomingSignature,
} from "./decision-protocol.js";
import type { KeyObject } from "node:crypto";

/** These values describe authorization, not a verdict that code is harmless. */
export interface IncomingContext {
  schema: 1;
  repositoryId: string;
  baselineDigest: string;
  candidateDigest: string;
  policyDigest: string;
  generation: number;
}

export interface IncomingCheck {
  id: string;
  status: "pass" | "fail" | "skipped";
  evidenceDigest: string;
}

export interface IncomingVerification {
  schema: 1;
  context: IncomingContext;
  createdAt: number;
  checks: IncomingCheck[];
}

export interface IncomingApproval {
  schema: 1;
  context: IncomingContext;
  verificationDigest: string;
  signerId: string;
  issuedAt: number;
  expiresAt: number;
  signature: string;
}

/** The caller must obtain this authority independently of candidate files. */
export interface IncomingAuthority {
  schema: 1;
  repositoryId: string;
  baselineDigest: string;
  policyDigest: string;
  generation: number;
  requiredChecks: string[];
  maxVerificationAgeMs: number;
  maxApprovalAgeMs: number;
  signers: { id: string; publicKeyPem: string }[];
}

export type IncomingDenial =
  | "invalid-time"
  | "missing-authority"
  | "invalid-authority"
  | "invalid-context"
  | "authority-mismatch"
  | "missing-verification"
  | "invalid-verification"
  | "verification-mismatch"
  | "stale-verification"
  | "checks-incomplete"
  | "missing-approval"
  | "invalid-approval"
  | "approval-mismatch"
  | "stale-approval"
  | "untrusted-signer"
  | "invalid-signature";

export type IncomingDecision =
  { allowed: true; reason: "accepted" } | { allowed: false; reason: IncomingDenial };

function refuse(reason: IncomingDenial): IncomingDecision {
  return { allowed: false, reason };
}

function matchesAuthority(context: IncomingContext, authority: IncomingAuthority): boolean {
  return (
    context.repositoryId === authority.repositoryId &&
    context.baselineDigest === authority.baselineDigest &&
    context.policyDigest === authority.policyDigest &&
    context.generation === authority.generation
  );
}

function completeChecks(report: IncomingVerification, authority: IncomingAuthority): boolean {
  const names = new Set(report.checks.map((check) => check.id));
  return (
    names.size === report.checks.length &&
    report.checks.every((check) => check.status === "pass") &&
    authority.requiredChecks.every((name) => names.has(name))
  );
}

function currentApproval(
  approval: IncomingApproval,
  report: IncomingVerification,
  authority: IncomingAuthority,
  now: number,
): boolean {
  return (
    approval.issuedAt >= report.createdAt &&
    approval.issuedAt <= now &&
    approval.expiresAt > now &&
    approval.expiresAt > approval.issuedAt &&
    approval.expiresAt - approval.issuedAt <= authority.maxApprovalAgeMs
  );
}

function verifyReport(
  verification: unknown,
  context: IncomingContext,
  authority: IncomingAuthority,
  now: number,
): IncomingVerification | IncomingDenial {
  if (verification == null) return "missing-verification";
  if (!incomingVerification(verification)) return "invalid-verification";
  if (!sameIncomingContext(context, verification.context)) return "verification-mismatch";
  if (
    verification.createdAt > now ||
    now - verification.createdAt >= authority.maxVerificationAgeMs
  ) {
    return "stale-verification";
  }
  if (!completeChecks(verification, authority)) return "checks-incomplete";
  return verification;
}

function decideApproval(
  approval: unknown,
  report: IncomingVerification,
  authority: IncomingAuthority,
  keys: Map<string, KeyObject>,
  now: number,
): IncomingDecision {
  if (approval == null) return refuse("missing-approval");
  if (!incomingApproval(approval)) return refuse("invalid-approval");
  if (
    !sameIncomingContext(report.context, approval.context) ||
    approval.verificationDigest !== incomingVerificationDigest(report)
  ) {
    return refuse("approval-mismatch");
  }
  if (!currentApproval(approval, report, authority, now)) return refuse("stale-approval");
  const key = keys.get(approval.signerId);
  if (!key) return refuse("untrusted-signer");
  if (!validIncomingSignature(approval, key)) return refuse("invalid-signature");
  return { allowed: true, reason: "accepted" };
}

/**
 * This pure decision does not intercept execution or establish key custody.
 * The caller must use external authority and hold an immutable snapshot through launch.
 */
export function decideIncomingExecution(
  context: unknown,
  verification: unknown,
  approval: unknown,
  authority: unknown,
  now: number,
): IncomingDecision {
  if (!incomingTimestamp(now)) return refuse("invalid-time");
  if (authority == null) return refuse("missing-authority");
  if (!incomingAuthority(authority)) return refuse("invalid-authority");
  const keys = incomingAuthorityKeys(authority);
  if (!keys) return refuse("invalid-authority");
  if (!incomingContext(context)) return refuse("invalid-context");
  if (!matchesAuthority(context, authority)) return refuse("authority-mismatch");
  const report = verifyReport(verification, context, authority, now);
  if (typeof report === "string") return refuse(report);
  return decideApproval(approval, report, authority, keys, now);
}
