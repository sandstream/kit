import assert from "node:assert/strict";
import { it } from "node:test";
import { getStats, insertMessage, openMemoryDb, upsertSession } from "./db.js";
import { mergeDb } from "./merge.js";
import { palAdd, palForget, palResolve, palShow } from "./pal.js";
import { replicas } from "./pal-causal.test-support.js";

it("refuses orphan revision history instead of silently dropping it from an import", (t) => {
  const { a, b, id, src } = replicas(t);
  upsertSession(a, { sessionId: "orphan-source", harness: "codex" });
  insertMessage(a, {
    uuid: "orphan-source-message",
    sessionId: "orphan-source",
    type: "assistant",
    content: "This must not accompany an incomplete task history.",
  });
  // Deliberately damaged export: the revision remains, but its task projection was lost.
  a.exec("DROP TRIGGER pal_state_delete");
  a.prepare("DELETE FROM pending_actions WHERE id=?").run(id);
  const before = palShow(b, id, { history: true });
  const stats = getStats(b);
  const changes = b.prepare("SELECT total_changes() AS n").get();
  assert.throws(() => mergeDb(b, src), /orphan.*history|history.*without.*task/i);
  assert.deepEqual(palShow(b, id, { history: true }), before);
  assert.deepEqual(getStats(b), stats);
  assert.deepEqual(b.prepare("SELECT total_changes() AS n").get(), changes);
});

it("startup refuses orphan history without inventing or deleting task state", (t) => {
  const { a, id, src } = replicas(t);
  a.exec("DROP TRIGGER pal_state_delete");
  a.prepare("DELETE FROM pending_actions WHERE id=?").run(id);
  const history = a.prepare("SELECT * FROM pal_revisions").all();
  const unexpected: ReturnType<typeof openMemoryDb>[] = [];
  t.after(() => unexpected.forEach((db) => db.isOpen && db.close()));
  assert.throws(() => unexpected.push(openMemoryDb(src)), /orphan.*history/i);
  assert.deepEqual(a.prepare("SELECT * FROM pal_revisions").all(), history);
  assert.equal(a.prepare("SELECT 1 FROM pending_actions WHERE id=?").get(id), undefined);
});

it("known target deletion still suppresses orphaned stale source history", (t) => {
  const { a, b, id, src } = replicas(t);
  assert.equal(palForget(b, id, { expectedFrontier: palShow(b, id)!.frontier }).status, "applied");
  a.exec("DROP TRIGGER pal_state_delete");
  a.prepare("DELETE FROM pending_actions WHERE id=?").run(id);
  assert.equal(mergeDb(b, src).pending, 0);
  assert.equal(palShow(b, id), null);
  assert.equal(b.prepare("SELECT count(*) AS n FROM pal_revisions").get()?.n, 0);
});

it("forwards every accepted portable title, including an empty string", (t) => {
  const { a, b, id, src, device } = replicas(t);
  device("a");
  const before = palShow(a, id)!;
  const changed = palResolve(a, id, {
    expectedFrontier: before.frontier,
    choice: { state: { ...before.heads[0].state, title: "" } },
  });
  assert.equal(changed.status, "applied");
  mergeDb(b, src);
  assert.deepEqual(palShow(b, id, { history: true }), palShow(a, id, { history: true }));
});

it("known deletion suppresses a stale malformed projection before validating its payload", (t) => {
  const { a, b, id, src } = replicas(t);
  palForget(b, id, { expectedFrontier: palShow(b, id)!.frontier });
  // Damaged stale export: SQLite permits a blob in a non-strict TEXT column.
  a.exec("DROP TRIGGER pal_state_update");
  a.prepare("UPDATE pending_actions SET title=? WHERE id=?").run(Buffer.from("bad"), id);
  assert.equal(mergeDb(b, src).pending, 0);
  assert.equal(palShow(b, id), null);
  assert.equal(b.prepare("SELECT count(*) AS n FROM pal_revisions").get()?.n, 0);
});

for (const damage of [
  "cycle",
  "missing parent",
  "foreign parent",
  "duplicate parent",
  "encoding",
  "projection",
  "identity collision",
]) {
  it(`refuses ${damage} without changing either store or partially importing messages`, (t) => {
    const { a, b, id, src } = replicas(t);
    const original = palShow(a, id)!;
    const root = original.heads[0].id;
    const changed = palResolve(a, id, {
      expectedFrontier: original.frontier,
      choice: { state: { ...original.heads[0].state, title: "New title" } },
    });
    assert.equal(changed.status, "applied");
    const head = changed.view!.heads[0].id;
    upsertSession(a, { sessionId: "graph-source", harness: "codex" });
    insertMessage(a, {
      uuid: "graph-source-only",
      sessionId: "graph-source",
      type: "assistant",
      content: "Atomic import must include complete task history.",
    });
    // Mutate a deliberately corrupted export, not a supported causal writer.
    a.exec("DROP TRIGGER pal_history_update; DROP TRIGGER pal_state_update");
    let error: RegExp;
    if (damage === "projection") {
      a.prepare("UPDATE pending_actions SET title='Unrecorded title' WHERE id=?").run(id);
      error = /projection does not match/i;
    } else if (damage === "identity collision") {
      a.prepare("UPDATE pal_revisions SET recorded_at='changed' WHERE rev_id=?").run(root);
      error = /identity has conflicting contents/i;
    } else if (damage === "encoding") {
      a.prepare("UPDATE pal_revisions SET parents_json='{' WHERE rev_id=?").run(head);
      error = /revision encoding/i;
    } else {
      let parents: string[];
      let revision = head;
      error = /missing or foreign parent/i;
      if (damage === "cycle") {
        parents = [head];
        revision = root;
        error = /ancestry contains a cycle/i;
      } else if (damage === "missing parent") parents = ["f".repeat(64)];
      else if (damage === "duplicate parent") {
        parents = [root, root];
        error = /invalid pending-action revision/i;
      } else {
        const foreign = palAdd(a, { title: "Unrelated task" });
        parents = [palShow(a, foreign)!.heads[0].id];
      }
      a.prepare("UPDATE pal_revisions SET parents_json=? WHERE rev_id=?").run(
        JSON.stringify(parents),
        revision,
      );
    }
    const source = a.prepare("SELECT * FROM pal_revisions ORDER BY rev_id").all();
    const before = palShow(b, id, { history: true });
    const stats = getStats(b);
    assert.throws(() => mergeDb(b, src), error);
    assert.deepEqual(palShow(b, id, { history: true }), before);
    assert.deepEqual(getStats(b), stats);
    assert.deepEqual(a.prepare("SELECT * FROM pal_revisions ORDER BY rev_id").all(), source);
  });
}
