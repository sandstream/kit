import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { signState, storeFixture } from "./authority-store.test-support.js";

const corruptions = [
  "invalid JSON",
  "extra state field",
  "altered signature",
  "missing proof",
  "different repository identity",
  "unsupported database version",
] as const;

function corrupt(f: ReturnType<typeof storeFixture>, kind: (typeof corruptions)[number]): void {
  const state = f.store.read(f.repository)!;
  const db = new DatabaseSync(join(f.directory, "authority.sqlite"));
  try {
    if (kind === "unsupported database version") {
      db.exec("PRAGMA user_version=2");
      return;
    }
    if (kind === "different repository identity") {
      db.prepare("UPDATE incoming SET repository_id=?").run("another-repository");
      return;
    }
    if (kind === "altered signature")
      state.acceptance!.approval.signature = Buffer.alloc(64).toString("base64");
    if (kind === "missing proof") state.acceptance = null;
    let body = JSON.stringify(state);
    if (kind === "invalid JSON") body = "{broken";
    if (kind === "extra state field") body = JSON.stringify({ ...state, unexpected: true });
    db.prepare("UPDATE incoming SET body=?").run(body);
  } finally {
    db.close();
  }
}

for (const kind of corruptions) {
  it(`denies ${kind} on public reads and preserves the damaged evidence`, () => {
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
      f.store.update(f.repository, signState(f, staged));
      corrupt(f, kind);
      const path = join(f.directory, "authority.sqlite");
      const damaged = readFileSync(path);
      assert.throws(() => f.store.read(f.repository));
      assert.deepEqual(f.store.decide(f.repository, "c".repeat(64), f.proof.now), {
        allowed: false,
        reason: "state-unavailable",
      });
      assert.throws(() =>
        f.store.update(f.repository, {
          type: "reject",
          expectedGeneration: 2,
          expectedPhase: "accepted",
        }),
      );
      assert.deepEqual(readFileSync(path), damaged);
    } finally {
      f.cleanup();
    }
  });
}
