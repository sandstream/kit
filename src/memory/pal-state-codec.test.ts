import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { fixture } from "./backup.test-support.js";
import { openMemoryDb } from "./db.js";
import { mergeDb } from "./merge.js";
import { palAdd, palClaim, palDone, palShow, palTakeover } from "./pal.js";
import { seedLegacyPalDb, withPalDevice } from "./pal-fixture.test-support.js";
import { replicas } from "./pal-causal.test-support.js";

it("migration and forwarding retain ten-field historical revisions without inventing session ownership", (t) => {
  const { src, dest, track } = fixture(t);
  const state = {
    status: "claimed",
    title: "old review",
    detail: null,
    scope: null,
    created_at: "2000-01-01 00:00:00",
    next_check: null,
    snooze_until: null,
    closed_at: null,
    claimed_by: "historical label",
    claimed_at: "2000-01-01 00:00:00",
  };
  seedLegacyPalDb(src, [{ id: "old", ...state }]);
  const old = new DatabaseSync(src);
  const historicalBytes = JSON.stringify(state);
  try {
    old.exec(`ALTER TABLE pending_actions ADD COLUMN sync_id TEXT;
      ALTER TABLE pending_actions ADD COLUMN origin_id TEXT;
      ALTER TABLE pending_actions ADD COLUMN state_conflict INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE pal_revisions (rev_id TEXT PRIMARY KEY, sync_id TEXT NOT NULL,
        parents_json TEXT NOT NULL, state_json TEXT NOT NULL, actor_device TEXT,
        observed INTEGER NOT NULL, recorded_at TEXT);
      CREATE TABLE pal_tombstones (sync_id TEXT PRIMARY KEY NOT NULL);
      UPDATE schema_meta SET version=15`);
    old.prepare("UPDATE pending_actions SET sync_id=?, origin_id='old'").run("a".repeat(32));
    old
      .prepare("INSERT INTO pal_revisions VALUES (?,?,?,?,?,0,?)")
      .run(
        "b".repeat(32),
        "a".repeat(32),
        "[]",
        historicalBytes,
        "old-device",
        "2000-01-01T00:00:00Z",
      );
  } finally {
    old.close();
  }
  const db = track(openMemoryDb(src));
  const legacy = palShow(db, "old")!;
  assert.deepEqual(legacy.heads[0].state, state);
  assert.equal(Object.hasOwn(legacy.heads[0].state, "claim_owner"), false);
  withPalDevice("new-device", () => {
    const owner = { device: "new-device", harness: "codex", session: "new-session" };
    assert.throws(() => palDone(db, "old", { owner, expectedFrontier: legacy.frontier }), {
      code: "legacy-owner",
    });
    assert.equal(
      palTakeover(db, "old", { owner, expectedFrontier: legacy.frontier }).status,
      "applied",
    );
  });
  const receiver = track(openMemoryDb(dest));
  mergeDb(receiver, src);
  assert.deepEqual(
    palShow(receiver, "old", { history: true }),
    palShow(db, "old", { history: true }),
  );
  for (const store of [db, receiver]) {
    assert.equal(
      store.prepare("SELECT state_json FROM pal_revisions WHERE rev_id=?").get("b".repeat(32))
        ?.state_json,
      historicalBytes,
    );
  }
});

it("the old causal-writer capability cannot modify a session-owned current store", (t) => {
  const { src, track } = fixture(t);
  withPalDevice("claim-device", () => {
    const db = track(openMemoryDb(src));
    const id = palAdd(db, { title: "retain current owner" });
    const owner = { device: "claim-device", harness: "codex", session: "current-session" };
    const claimed = palClaim(db, id, { owner, expectedFrontier: palShow(db, id)!.frontier });
    const old = track(new DatabaseSync(src));
    old.function("kit_pal_write", { varargs: true }, () => 1);
    assert.equal(
      old.prepare("SELECT kit_pal_write('state',?,?) AS allowed").get(id, claimed.view!.syncId)
        ?.allowed,
      1,
    );
    assert.throws(
      () =>
        old
          .prepare(
            "UPDATE pending_actions SET status='closed', claimed_by=NULL, claimed_at=NULL WHERE id=?",
          )
          .run(id),
      /kit_pal_write_v16|ownership-aware writer/i,
    );
    assert.deepEqual(palShow(db, id), claimed.view);
    assert.equal(palDone(old, id, { owner, expectedFrontier: claimed.view!.frontier }), true);
  });
});

it("import rejects encoded owner strings instead of normalizing changed immutable revision bodies", (t) => {
  const { a, b, id, device, src, dest } = replicas(t);
  device("a");
  const owner = { device: "causal-device-a", harness: "codex", session: "owner" };
  palClaim(a, id, { owner, expectedFrontier: palShow(a, id)!.frontier });
  mergeDb(b, src);
  const before = palShow(a, id, { history: true })!;
  const sourceHead = before.heads[0];
  // Model an invalid exported store, not a permitted current writer operation.
  b.exec("DROP TRIGGER pal_history_update");
  b.prepare("UPDATE pal_revisions SET state_json=? WHERE rev_id=?").run(
    JSON.stringify({ ...sourceHead.state, claim_owner: JSON.stringify(owner) }),
    sourceHead.id,
  );
  const changes = a.prepare("SELECT total_changes() AS n").get();
  assert.throws(() => mergeDb(a, dest), /claim owner/i);
  assert.deepEqual(palShow(a, id, { history: true }), before);
  assert.deepEqual(a.prepare("SELECT total_changes() AS n").get(), changes);
});
