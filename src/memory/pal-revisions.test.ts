import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { getStats, insertMessage, openMemoryDb, upsertSession } from "./db.js";
import { mergeDb } from "./merge.js";
import { palForget, palShow } from "./pal.js";
import { replicas } from "./pal-causal.test-support.js";

it("a causal store with missing history refuses reopen without inventing a legacy observation", (t) => {
  const { a, id, src } = replicas(t);
  // Corrupted bytes from a database owner: ordinary clients cannot delete these rows.
  a.exec("DROP TRIGGER pal_history_delete; DELETE FROM pal_revisions");
  const row = a.prepare("SELECT * FROM pending_actions WHERE id=?").get(id);
  const version = a.prepare("SELECT version FROM schema_meta").get();
  const unexpected: DatabaseSync[] = [];
  t.after(() => unexpected.forEach((db) => db.isOpen && db.close()));
  assert.throws(() => unexpected.push(openMemoryDb(src)), /causal history is missing/i);
  assert.deepEqual(a.prepare("SELECT * FROM pending_actions WHERE id=?").get(id), row);
  assert.deepEqual(a.prepare("SELECT version FROM schema_meta").get(), version);
  assert.equal(a.prepare("SELECT count(*) AS n FROM pal_revisions").get()?.n, 0);
  assert.throws(() => palShow(a, id), /causal history is missing/i);
});

for (const table of ["pal_revisions", "pal_tombstones"]) {
  for (const empty of [false, true]) {
    it(`import refuses missing ${table} in a causal store with ${empty ? "no" : "retained"} actions`, (t) => {
      const { a, b, id, src } = replicas(t);
      upsertSession(a, { sessionId: "damaged-source", harness: "codex" });
      insertMessage(a, {
        uuid: "source-only",
        sessionId: "damaged-source",
        type: "user",
        content: "must not be partially imported",
      });
      if (empty) palForget(a, id, { expectedFrontier: palShow(a, id)!.frontier });
      // Deliberately corrupt an owned source, bypassing the protections ordinary writers obey.
      a.exec(`DROP TABLE ${table}`);
      const before = palShow(b, id, { history: true });
      const stats = getStats(b);
      assert.throws(() => mergeDb(b, src), /causal history is missing/i);
      assert.deepEqual(palShow(b, id, { history: true }), before);
      assert.deepEqual(getStats(b), stats, "all imported content rolls back on refusal");
    });
  }
}

it("reopen cannot silently recreate a missing causal table after the last action was forgotten", (t) => {
  const { a, id, src } = replicas(t);
  assert.equal(palForget(a, id, { expectedFrontier: palShow(a, id)!.frontier }).status, "applied");
  // Lost table bytes must not be interpreted as an empty, valid deletion history.
  a.exec("DROP TABLE pal_tombstones");
  const unexpected: DatabaseSync[] = [];
  t.after(() => unexpected.forEach((db) => db.isOpen && db.close()));
  assert.throws(() => unexpected.push(openMemoryDb(src)), /causal history is missing/i);
  assert.equal(
    a.prepare("SELECT name FROM sqlite_master WHERE name='pal_tombstones'").get(),
    undefined,
  );
  assert.equal(a.prepare("SELECT count(*) AS n FROM pending_actions").get()?.n, 0);
});
