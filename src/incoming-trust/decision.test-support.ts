import { createHash, generateKeyPairSync, sign } from "node:crypto";
import type {
  IncomingApproval,
  IncomingAuthority,
  IncomingContext,
  IncomingVerification,
} from "./decision.js";

/** Independent fixture encoder. Do not import the production protocol here. */
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

export function decisionFixture() {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const id = createHash("sha256")
    .update(keys.publicKey.export({ type: "spki", format: "der" }))
    .digest("hex");
  const now = 1_800_000_000_000;
  const context: IncomingContext = {
    schema: 1,
    repositoryId: "repo-1",
    baselineDigest: "b".repeat(64),
    candidateDigest: "c".repeat(64),
    policyDigest: "d".repeat(64),
    generation: 3,
  };
  const authority: IncomingAuthority = {
    schema: 1,
    repositoryId: context.repositoryId,
    baselineDigest: context.baselineDigest,
    policyDigest: context.policyDigest,
    generation: context.generation,
    requiredChecks: ["inventory", "artifacts", "scanners"],
    maxVerificationAgeMs: 60_000,
    maxApprovalAgeMs: 30_000,
    signers: [{ id, publicKeyPem }],
  };
  const verification: IncomingVerification = {
    schema: 1,
    context: { ...context },
    createdAt: now - 2_000,
    checks: authority.requiredChecks.map((name) => ({
      id: name,
      status: "pass",
      evidenceDigest: "e".repeat(64),
    })),
  };
  const approval: IncomingApproval = {
    schema: 1,
    context: { ...context },
    verificationDigest: "",
    signerId: id,
    issuedAt: now - 1_000,
    expiresAt: now + 10_000,
    signature: "",
  };
  const resign = () => {
    approval.verificationDigest = fixtureVerificationDigest(verification);
    const statement = JSON.stringify([
      "kit.incoming-approval",
      1,
      contextFields(approval.context),
      approval.verificationDigest,
      approval.signerId,
      approval.issuedAt,
      approval.expiresAt,
    ]);
    approval.signature = sign(null, Buffer.from(statement), keys.privateKey).toString("base64");
  };
  resign();
  return { context, authority, verification, approval, now, resign, keys };
}

export function fixtureVerificationDigest(report: IncomingVerification): string {
  const statement = JSON.stringify([
    "kit.incoming-verification",
    1,
    contextFields(report.context),
    report.createdAt,
    report.checks.map((check) => [check.id, check.status, check.evidenceDigest]),
  ]);
  return createHash("sha256").update(statement).digest("hex");
}
