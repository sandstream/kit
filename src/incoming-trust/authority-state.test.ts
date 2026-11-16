import assert from "node:assert/strict";
import { it } from "node:test";
import { signState, storeFixture } from "./authority-store.test-support.js";

it("requires complete signed evidence and invalidates it when a different candidate arrives", () => {
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
    assert.equal(staged.phase, "pending");
    assert.equal(staged.authority.generation, 2);
    assert.deepEqual(f.store.decide(f.repository, "c".repeat(64), f.proof.now), {
      allowed: false,
      reason: "pending",
    });
    const accepted = f.store.update(f.repository, signState(f, staged));
    assert.equal(accepted.phase, "accepted");
    assert.deepEqual(f.store.decide(f.repository, "c".repeat(64), f.proof.now), {
      allowed: true,
      reason: "accepted",
    });
    assert.deepEqual(f.store.decide(f.repository, "f".repeat(64), f.proof.now), {
      allowed: false,
      reason: "candidate-mismatch",
    });
    const changed = f.store.update(f.repository, {
      type: "stage",
      evidence: [],
      expectedGeneration: 2,
      expectedPhase: "accepted",
      candidateDigest: "f".repeat(64),
    });
    assert.equal(changed.authority.generation, 3);
    assert.equal(changed.authority.baselineDigest, "c".repeat(64));
    assert.equal(changed.acceptance, null);
    assert.deepEqual(f.store.decide(f.repository, "c".repeat(64), f.proof.now), {
      allowed: false,
      reason: "pending",
    });
  } finally {
    f.cleanup();
  }
});

it("preserves rejection until explicit retry and refuses the earlier signed approval", () => {
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
    const oldApproval = structuredClone(signState(f, staged));
    f.store.update(f.repository, oldApproval);
    const rejected = f.store.update(f.repository, {
      type: "reject",
      expectedGeneration: 2,
      expectedPhase: "accepted",
    });
    assert.equal(rejected.phase, "rejected");
    assert.equal(rejected.authority.generation, 3);
    assert.equal(
      rejected.authority.baselineDigest,
      f.proof.authority.baselineDigest,
      "rejecting a candidate must not make it the baseline",
    );
    assert.equal(rejected.acceptance, null);
    assert.deepEqual(
      f.store.update(f.repository, {
        type: "stage",
        evidence: [],
        expectedGeneration: 3,
        expectedPhase: "rejected",
        candidateDigest: "c".repeat(64),
      }),
      rejected,
    );
    assert.deepEqual(f.store.decide(f.repository, "c".repeat(64), f.proof.now), {
      allowed: false,
      reason: "rejected",
    });
    const pending = f.store.update(f.repository, {
      type: "retry",
      expectedGeneration: 3,
      expectedPhase: "rejected",
    });
    assert.equal(pending.authority.generation, 4);
    assert.equal(pending.phase, "pending");
    assert.throws(
      () =>
        f.store.update(f.repository, {
          ...oldApproval,
          expectedGeneration: 4,
          expectedPhase: "pending",
        }),
      /verification-mismatch/,
    );
    assert.deepEqual(f.store.read(f.repository), pending);
    f.store.update(f.repository, signState(f, pending));
    assert.deepEqual(f.store.decide(f.repository, "c".repeat(64), f.proof.now), {
      allowed: true,
      reason: "accepted",
    });
  } finally {
    f.cleanup();
  }
});
