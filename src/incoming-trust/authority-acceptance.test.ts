import assert from "node:assert/strict";
import { it } from "node:test";
import { signState, storeFixture } from "./authority-store.test-support.js";

const invalidProofs = [
  ["missing required check", "checks-incomplete"],
  ["failed check", "checks-incomplete"],
  ["future verification", "stale-verification"],
  ["different candidate", "verification-mismatch"],
  ["expired approval", "stale-approval"],
  ["unknown signer", "untrusted-signer"],
  ["forged signature", "invalid-signature"],
] as const;

function invalidate(f: ReturnType<typeof storeFixture>, kind: string): void {
  if (kind === "missing required check") f.proof.verification.checks.pop();
  if (kind === "failed check") f.proof.verification.checks[0].status = "fail";
  if (kind === "future verification") f.proof.verification.createdAt = f.proof.now + 1;
  if (kind === "different candidate") f.proof.verification.context.candidateDigest = "a".repeat(64);
  if (kind === "expired approval") f.proof.approval.expiresAt = f.proof.now;
  if (kind === "unknown signer") f.proof.approval.signerId = "a".repeat(64);
  f.proof.resign();
  if (kind === "forged signature")
    f.proof.approval.signature = Buffer.alloc(64, 1).toString("base64");
}

for (const [kind, reason] of invalidProofs) {
  it(`refuses ${kind} and retains the pending state`, () => {
    const f = storeFixture();
    try {
      f.store.update(f.repository, { type: "enroll", authority: f.proof.authority });
      const staged = f.store.update(f.repository, {
        type: "stage",
        evidence: [],
        expectedGeneration: 1,
        expectedPhase: "pending",
        candidateDigest: "c".repeat(64),
      });
      const action = signState(f, staged);
      invalidate(f, kind);
      assert.throws(() => f.store.update(f.repository, action), new RegExp(reason));
      assert.deepEqual(f.store.read(f.repository), staged);
      assert.deepEqual(f.store.decide(f.repository, "c".repeat(64), f.proof.now), {
        allowed: false,
        reason: "pending",
      });
    } finally {
      f.cleanup();
    }
  });
}

it("rechecks expiry and validates the exact input when a stored approval is used", () => {
  const f = storeFixture();
  try {
    f.store.update(f.repository, { type: "enroll", authority: f.proof.authority });
    const staged = f.store.update(f.repository, {
      type: "stage",
      evidence: [],
      expectedGeneration: 1,
      expectedPhase: "pending",
      candidateDigest: "c".repeat(64),
    });
    const action = signState(f, staged);
    const accepted = f.store.update(f.repository, action);
    assert.deepEqual(f.store.decide(f.repository, "c".repeat(64), f.proof.approval.expiresAt), {
      allowed: false,
      reason: "stale-approval",
    });
    assert.deepEqual(f.store.decide(f.repository, "invalid", f.proof.now), {
      allowed: false,
      reason: "invalid-context",
    });
    assert.deepEqual(f.store.decide(f.repository, "c".repeat(64), NaN), {
      allowed: false,
      reason: "invalid-time",
    });
    action.approval.signature = Buffer.alloc(64, 1).toString("base64");
    assert.deepEqual(
      f.store.read(f.repository),
      accepted,
      "caller mutations must not alter persisted approval",
    );
  } finally {
    f.cleanup();
  }
});
