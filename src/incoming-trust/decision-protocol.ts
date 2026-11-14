import { createHash, createPublicKey, verify } from "node:crypto";
import type { KeyObject } from "node:crypto";
import type {
  IncomingApproval,
  IncomingAuthority,
  IncomingContext,
  IncomingVerification,
} from "./decision.js";

function contextFields(context: IncomingContext): unknown[] {
  return [
    context.schema,
    context.repositoryId,
    context.baselineDigest,
    context.candidateDigest,
    context.policyDigest,
    context.generation,
  ];
}

export function sameIncomingContext(left: IncomingContext, right: IncomingContext): boolean {
  return JSON.stringify(contextFields(left)) === JSON.stringify(contextFields(right));
}

/** Callers must validate the report schema before they compute its digest. */
export function incomingVerificationDigest(report: IncomingVerification): string {
  const statement = [
    "kit.incoming-verification",
    1,
    contextFields(report.context),
    report.createdAt,
    report.checks.map((check) => [check.id, check.status, check.evidenceDigest]),
  ];
  return createHash("sha256").update(JSON.stringify(statement)).digest("hex");
}

/** The signature covers every approval field except the signature itself. */
export function incomingApprovalStatement(approval: Omit<IncomingApproval, "signature">): Buffer {
  const statement = [
    "kit.incoming-approval",
    1,
    contextFields(approval.context),
    approval.verificationDigest,
    approval.signerId,
    approval.issuedAt,
    approval.expiresAt,
  ];
  return Buffer.from(JSON.stringify(statement));
}

export function incomingAuthorityKeys(authority: IncomingAuthority): Map<string, KeyObject> | null {
  const keys = new Map<string, KeyObject>();
  try {
    for (const signer of authority.signers) {
      const key = createPublicKey(signer.publicKeyPem);
      if (key.asymmetricKeyType !== "ed25519" || keys.has(signer.id)) return null;
      const id = createHash("sha256")
        .update(key.export({ type: "spki", format: "der" }))
        .digest("hex");
      if (id !== signer.id) return null;
      keys.set(id, key);
    }
    return keys;
  } catch {
    return null;
  }
}

export function validIncomingSignature(approval: IncomingApproval, key: KeyObject): boolean {
  return verify(
    null,
    incomingApprovalStatement(approval),
    key,
    Buffer.from(approval.signature, "base64"),
  );
}
