import type {
  IncomingApproval,
  IncomingAuthority,
  IncomingCheck,
  IncomingContext,
  IncomingVerification,
} from "./decision.js";

type RecordValue = Record<string, unknown>;

function fields(value: unknown, names: string[]): value is RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === names.length && names.every((name) => Object.hasOwn(value, name));
}

function digest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function label(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/.test(value);
}

export function incomingTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function positiveInteger(value: unknown): value is number {
  return incomingTimestamp(value) && value > 0;
}

export function incomingContext(value: unknown): value is IncomingContext {
  if (
    !fields(value, [
      "schema",
      "repositoryId",
      "baselineDigest",
      "candidateDigest",
      "policyDigest",
      "generation",
    ])
  )
    return false;
  return (
    value.schema === 1 &&
    label(value.repositoryId) &&
    digest(value.baselineDigest) &&
    digest(value.candidateDigest) &&
    digest(value.policyDigest) &&
    positiveInteger(value.generation)
  );
}

export function incomingCheck(value: unknown): value is IncomingCheck {
  if (!fields(value, ["id", "status", "evidenceDigest"])) return false;
  return (
    label(value.id) &&
    typeof value.status === "string" &&
    ["pass", "fail", "skipped"].includes(value.status) &&
    digest(value.evidenceDigest)
  );
}

export function incomingVerification(value: unknown): value is IncomingVerification {
  if (!fields(value, ["schema", "context", "createdAt", "checks"])) return false;
  return (
    value.schema === 1 &&
    incomingContext(value.context) &&
    incomingTimestamp(value.createdAt) &&
    Array.isArray(value.checks) &&
    value.checks.length <= 128 &&
    value.checks.every(incomingCheck)
  );
}

function signer(value: unknown): value is IncomingAuthority["signers"][number] {
  if (!fields(value, ["id", "publicKeyPem"])) return false;
  return (
    digest(value.id) &&
    typeof value.publicKeyPem === "string" &&
    value.publicKeyPem.length <= 4096 &&
    value.publicKeyPem.startsWith("-----BEGIN PUBLIC KEY-----")
  );
}

export function incomingAuthority(value: unknown): value is IncomingAuthority {
  if (
    !fields(value, [
      "schema",
      "repositoryId",
      "baselineDigest",
      "policyDigest",
      "generation",
      "requiredChecks",
      "maxVerificationAgeMs",
      "maxApprovalAgeMs",
      "signers",
    ])
  )
    return false;
  return (
    value.schema === 1 &&
    label(value.repositoryId) &&
    digest(value.baselineDigest) &&
    digest(value.policyDigest) &&
    positiveInteger(value.generation) &&
    positiveInteger(value.maxVerificationAgeMs) &&
    positiveInteger(value.maxApprovalAgeMs) &&
    requiredChecks(value.requiredChecks) &&
    signers(value.signers)
  );
}

function requiredChecks(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 128 &&
    value.every(label) &&
    new Set(value).size === value.length
  );
}

function signers(value: unknown): value is IncomingAuthority["signers"] {
  return Array.isArray(value) && value.length > 0 && value.length <= 32 && value.every(signer);
}

export function incomingApproval(value: unknown): value is IncomingApproval {
  if (
    !fields(value, [
      "schema",
      "context",
      "verificationDigest",
      "signerId",
      "issuedAt",
      "expiresAt",
      "signature",
    ])
  )
    return false;
  return (
    value.schema === 1 &&
    incomingContext(value.context) &&
    digest(value.verificationDigest) &&
    digest(value.signerId) &&
    incomingTimestamp(value.issuedAt) &&
    incomingTimestamp(value.expiresAt) &&
    typeof value.signature === "string" &&
    /^[A-Za-z0-9+/]{86}==$/.test(value.signature) &&
    Buffer.from(value.signature, "base64").toString("base64") === value.signature
  );
}
