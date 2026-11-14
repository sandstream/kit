import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { IncomingTrustStore } from "./authority-store.js";
import { storeFixture } from "./authority-store.test-support.js";

it("enrolls external authority without approving code and reads it in a fresh store", () => {
  const f = storeFixture();
  try {
    assert.equal(f.store.read(f.repository), null);
    assert.equal(existsSync(f.directory), false, "a read must not create state");
    const state = f.store.update(f.repository, { type: "enroll", authority: f.proof.authority });
    assert.deepEqual(state, {
      schema: 1,
      authority: f.proof.authority,
      phase: "pending",
      candidateDigest: null,
      acceptance: null,
    });
    assert.deepEqual(new IncomingTrustStore(f.directory).read(f.repository), state);
    assert.throws(
      () => f.store.update(f.repository, { type: "enroll", authority: f.proof.authority }),
      /already-enrolled/,
    );
    assert.deepEqual(f.store.read(f.repository), state);
  } finally {
    f.cleanup();
  }
});

it("does not create authority for an unenrolled mutation or repository-supplied files", () => {
  const f = storeFixture();
  try {
    const incoming = join(f.repository, ".kit", "incoming-trust");
    mkdirSync(incoming, { recursive: true });
    writeFileSync(join(incoming, "authority.json"), JSON.stringify(f.proof.authority));
    assert.throws(
      () =>
        f.store.update(f.repository, {
          type: "reject",
          expectedGeneration: 1,
          expectedPhase: "pending",
        }),
      /not-enrolled/,
    );
    assert.deepEqual(f.store.decide(f.repository, "c".repeat(64), f.proof.now), {
      allowed: false,
      reason: "not-enrolled",
    });
    assert.equal(existsSync(f.directory), false);
  } finally {
    f.cleanup();
  }
});

it("refuses invalid or replacement authority and leaves the enrolled keys unchanged", () => {
  const f = storeFixture();
  try {
    assert.throws(
      () =>
        f.store.update(f.repository, {
          type: "enroll",
          authority: { ...f.proof.authority, generation: 2 },
        }),
      /invalid-authority/,
    );
    assert.equal(existsSync(f.directory), false);
    const enrolled = f.store.update(f.repository, { type: "enroll", authority: f.proof.authority });
    const changed = { ...f.proof.authority, policyDigest: "a".repeat(64) };
    assert.throws(
      () => f.store.update(f.repository, { type: "enroll", authority: changed }),
      /already-enrolled/,
    );
    assert.deepEqual(f.store.read(f.repository), enrolled);
  } finally {
    f.cleanup();
  }
});

it("refuses every mutation in read-only mode and retains read access", () => {
  const f = storeFixture();
  const before = process.env.KIT_READ_ONLY;
  try {
    process.env.KIT_READ_ONLY = "1";
    assert.throws(
      () => f.store.update(f.repository, { type: "enroll", authority: f.proof.authority }),
      /read-only/,
    );
    assert.equal(existsSync(f.directory), false);
    delete process.env.KIT_READ_ONLY;
    const enrolled = f.store.update(f.repository, { type: "enroll", authority: f.proof.authority });
    process.env.KIT_READ_ONLY = "1";
    for (const type of ["reject", "retry"] as const) {
      assert.throws(
        () =>
          f.store.update(f.repository, { type, expectedGeneration: 1, expectedPhase: "pending" }),
        /read-only/,
      );
    }
    assert.throws(
      () =>
        f.store.update(f.repository, {
          type: "stage",
          expectedGeneration: 1,
          expectedPhase: "pending",
          candidateDigest: "c".repeat(64),
        }),
      /read-only/,
    );
    assert.throws(
      () =>
        f.store.update(f.repository, {
          type: "accept",
          expectedGeneration: 1,
          expectedPhase: "pending",
          verification: f.proof.verification,
          approval: f.proof.approval,
          now: f.proof.now,
        }),
      /read-only/,
    );
    assert.deepEqual(f.store.read(f.repository), enrolled);
  } finally {
    if (before === undefined) delete process.env.KIT_READ_ONLY;
    else process.env.KIT_READ_ONLY = before;
    f.cleanup();
  }
});
