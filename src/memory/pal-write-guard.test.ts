import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { palDone, palForget, palList, palShow } from "./pal.js";
import { openMemoryDb } from "./db.js";
import { replicas } from "./pal-causal.test-support.js";

it("persistent guards refuse unrecorded task writes from current and legacy connections", (t) => {
  const { a, id, src } = replicas(t);
  const old = new DatabaseSync(src);
  try {
    const before = palShow(a, id, { history: true });
    const rows = palList(a, { readOnly: true, allDevices: true });
    for (const db of [a, old]) {
      for (const sql of [
        "UPDATE pending_actions SET title='unrecorded' WHERE id=?",
        "UPDATE pending_actions SET origin_root='/changed' WHERE id=?",
        "UPDATE pending_actions SET state_conflict=0 WHERE id=?",
        "DELETE FROM pending_actions WHERE id=?",
        "INSERT INTO pending_actions(id,title) VALUES (?, 'unrecorded')",
        "INSERT OR REPLACE INTO pending_actions(id,title) VALUES (?, 'replacement')",
      ]) {
        assert.throws(() => db.prepare(sql).run(id), /kit_pal_write|causal writer/i, sql);
        assert.deepEqual(palShow(a, id, { history: true }), before);
        assert.deepEqual(palList(a, { readOnly: true, allDevices: true }), rows);
      }
    }
    assert.equal(palDone(a, id), true);
    assert.equal(palShow(a, id, { history: true })?.history?.length, 2);
    assert.throws(
      () => a.prepare("UPDATE pending_actions SET status='open' WHERE id=?").run(id),
      /causal writer/i,
    );
  } finally {
    old.close();
  }
});

it("aborted state writes leave no history or lingering SQL permission and callers may roll back", (t) => {
  const { a, id, src } = replicas(t);
  const before = palShow(a, id, { history: true });
  a.exec(`CREATE TEMP TRIGGER reject_state BEFORE UPDATE ON pending_actions
    BEGIN SELECT RAISE(ABORT, 'fixture rejected state'); END`);
  assert.throws(() => palDone(a, id), /fixture rejected state/);
  assert.deepEqual(palShow(a, id, { history: true }), before);
  a.exec("DROP TRIGGER reject_state");
  assert.throws(() => a.exec("UPDATE pending_actions SET title='unguarded'"), /causal writer/i);
  a.exec("BEGIN");
  try {
    assert.equal(palDone(a, id), true);
    assert.equal(palShow(a, id)?.heads[0].state.status, "closed");
  } finally {
    a.exec("ROLLBACK");
  }
  assert.deepEqual(palShow(a, id, { history: true }), before);
  const reopened = openMemoryDb(src);
  try {
    assert.throws(
      () => reopened.exec("UPDATE pending_actions SET title='migration permission leak'"),
      /causal writer/i,
    );
    assert.equal(palDone(reopened, id), true);
  } finally {
    reopened.close();
  }
});

it("revision bodies are append-only and deletion records cannot be rewritten or removed", (t) => {
  const { a, id, src } = replicas(t);
  const old = new DatabaseSync(src);
  try {
    const before = palShow(a, id, { history: true })!;
    for (const db of [a, old]) {
      for (const sql of [
        "UPDATE pal_revisions SET state_json='{}'",
        "DELETE FROM pal_revisions",
        "INSERT OR REPLACE INTO pal_revisions SELECT * FROM pal_revisions",
        "INSERT INTO pal_revisions SELECT '00000000000000000000000000000000',sync_id,parents_json,state_json,actor_device,observed,recorded_at FROM pal_revisions",
      ]) {
        assert.throws(() => db.exec(sql), /kit_pal_write|causal writer|append.only/i, sql);
        assert.deepEqual(palShow(a, id, { history: true }), before);
      }
    }
    assert.equal(palForget(a, id, { expectedFrontier: before.frontier }).ok, true);
    for (const db of [a, old]) {
      for (const sql of [
        "DELETE FROM pal_tombstones",
        "UPDATE pal_tombstones SET sync_id='00000000000000000000000000000000'",
        "INSERT OR REPLACE INTO pal_tombstones SELECT * FROM pal_tombstones",
      ])
        assert.throws(() => db.exec(sql), /kit_pal_write|causal writer|append.only/i, sql);
    }
  } finally {
    old.close();
  }
});
