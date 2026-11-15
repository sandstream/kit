import assert from "node:assert/strict";
import { readFileSync, readdirSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { decisionFixture } from "./decision.test-support.js";
import { signState, storeFixture } from "./authority-store.test-support.js";

function acceptFixture(f: ReturnType<typeof storeFixture>): void {
  f.store.update(f.repository, { type: "enroll", authority: f.proof.authority });
  const staged = f.store.update(f.repository, {
    type: "stage",
    evidence: [],
    expectedGeneration: 1,
    expectedPhase: "pending",
    candidateDigest: "c".repeat(64),
  });
  f.store.update(f.repository, signState(f, staged));
}

it("preserves a truncated database and refuses replacement enrollment", () => {
  const f = storeFixture();
  try {
    acceptFixture(f);
    const path = join(f.directory, "authority.sqlite");
    truncateSync(path, 0);
    const replacement = decisionFixture().authority;
    replacement.generation = 1;
    assert.throws(() => f.store.read(f.repository));
    assert.throws(() => f.store.update(f.repository, { type: "enroll", authority: replacement }));
    assert.equal(readFileSync(path).length, 0, "damaged evidence must not be reset");
    assert.deepEqual(readdirSync(f.directory), ["authority.sqlite"]);
  } finally {
    f.cleanup();
  }
});

it("refuses WAL authority before a read can create sidecar files", () => {
  const f = storeFixture();
  const previous = process.env.KIT_READ_ONLY;
  try {
    acceptFixture(f);
    const path = join(f.directory, "authority.sqlite");
    const db = new DatabaseSync(path);
    try {
      db.exec("PRAGMA journal_mode=WAL");
    } finally {
      db.close();
    }
    const before = readFileSync(path);
    assert.deepEqual(readdirSync(f.directory), ["authority.sqlite"]);
    process.env.KIT_READ_ONLY = "1";
    const decision = f.store.decide(f.repository, "c".repeat(64), f.proof.now);
    assert.deepEqual(
      readdirSync(f.directory),
      ["authority.sqlite"],
      "a decision must create no WAL or shared-memory files",
    );
    assert.deepEqual(decision, { allowed: false, reason: "state-unavailable" });
    assert.throws(() => f.store.read(f.repository));
    delete process.env.KIT_READ_ONLY;
    assert.throws(() =>
      f.store.update(f.repository, {
        type: "reject",
        expectedGeneration: 2,
        expectedPhase: "accepted",
      }),
    );
    assert.deepEqual(readFileSync(path), before);
    assert.deepEqual(readdirSync(f.directory), ["authority.sqlite"]);
  } finally {
    if (previous === undefined) delete process.env.KIT_READ_ONLY;
    else process.env.KIT_READ_ONLY = previous;
    f.cleanup();
  }
});

for (const suffix of ["-wal", "-shm"]) {
  it(`refuses existing ${suffix} even when the main database uses rollback format`, () => {
    const f = storeFixture();
    const previous = process.env.KIT_READ_ONLY;
    try {
      acceptFixture(f);
      const path = join(f.directory, "authority.sqlite");
      const database = readFileSync(path);
      assert.equal(database[18], 1);
      assert.equal(database[19], 1);
      writeFileSync(path + suffix, Buffer.alloc(64, 1), { mode: 0o600 });
      const snapshot = () =>
        readdirSync(f.directory)
          .sort()
          .map((name) => ({ name, bytes: readFileSync(join(f.directory, name)) }));
      const before = snapshot();
      const assertPreserved = () => {
        const after = snapshot();
        assert.deepEqual(
          after.map((file) => file.name),
          before.map((file) => file.name),
        );
        for (let index = 0; index < before.length; index++)
          assert.ok(
            after[index].bytes.equals(before[index].bytes),
            `${before[index].name} must retain its exact bytes`,
          );
      };
      process.env.KIT_READ_ONLY = "1";
      const decision = f.store.decide(f.repository, "c".repeat(64), f.proof.now);
      assertPreserved();
      assert.deepEqual(decision, { allowed: false, reason: "state-unavailable" });
      assert.throws(() => f.store.read(f.repository));
      delete process.env.KIT_READ_ONLY;
      assert.throws(() =>
        f.store.update(f.repository, {
          type: "reject",
          expectedGeneration: 2,
          expectedPhase: "accepted",
        }),
      );
      assertPreserved();
    } finally {
      if (previous === undefined) delete process.env.KIT_READ_ONLY;
      else process.env.KIT_READ_ONLY = previous;
      f.cleanup();
    }
  });
}
