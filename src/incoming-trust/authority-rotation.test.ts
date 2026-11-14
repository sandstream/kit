import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decisionFixture } from "./decision.test-support.js";
import { signState, storeFixture } from "./authority-store.test-support.js";

function accepted(f: ReturnType<typeof storeFixture>) {
  f.store.update(f.repository, { type: "enroll", authority: f.proof.authority });
  const staged = f.store.update(f.repository, {
    type: "stage",
    expectedGeneration: 1,
    expectedPhase: "pending",
    candidateDigest: "c".repeat(64),
  });
  return f.store.update(f.repository, signState(f, staged));
}

describe("authority key rotation", () => {
  it("replaces the signers, advances the generation and voids the old approval", () => {
    const f = storeFixture();
    try {
      const before = accepted(f);
      const next = decisionFixture().authority.signers;
      const state = f.store.update(f.repository, {
        type: "rotate",
        expectedGeneration: before.authority.generation,
        expectedPhase: "accepted",
        signers: next,
      });
      assert.deepEqual(state.authority.signers, next);
      assert.equal(state.authority.generation, before.authority.generation + 1);
      assert.equal(state.phase, "pending");
      assert.equal(state.acceptance, null);
      assert.deepEqual(f.store.read(f.repository), state);
      assert.deepEqual(f.store.decide(f.repository, "c".repeat(64), f.proof.now), {
        allowed: false,
        reason: "pending",
      });
    } finally {
      f.cleanup();
    }
  });

  const refusals = [
    ["the same signers", (f: ReturnType<typeof storeFixture>) => f.proof.authority.signers],
    ["an empty signer list", () => []],
    [
      "a signer with a mismatched id",
      () => [{ ...decisionFixture().authority.signers[0], id: "a".repeat(64) }],
    ],
  ] as const;
  for (const [name, pick] of refusals) {
    it(`refuses ${name} and keeps the state`, () => {
      const f = storeFixture();
      try {
        const before = accepted(f);
        assert.throws(() =>
          f.store.update(f.repository, {
            type: "rotate",
            expectedGeneration: before.authority.generation,
            expectedPhase: "accepted",
            signers: pick(f),
          }),
        );
        assert.deepEqual(f.store.read(f.repository), before);
      } finally {
        f.cleanup();
      }
    });
  }

  it("refuses a stale generation", () => {
    const f = storeFixture();
    try {
      const before = accepted(f);
      assert.throws(
        () =>
          f.store.update(f.repository, {
            type: "rotate",
            expectedGeneration: before.authority.generation + 1,
            expectedPhase: "accepted",
            signers: decisionFixture().authority.signers,
          }),
        /stale-generation/,
      );
    } finally {
      f.cleanup();
    }
  });
});
