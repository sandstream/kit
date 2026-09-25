import assert from "node:assert/strict";
import { it } from "node:test";
import { forgetMemory, insertMessage, searchMessages, upsertSession } from "./db.js";
import { palList, palResolve, palShow } from "./pal.js";
import { commonGitTask, gitHistoryFixture } from "./remote-sync-causal.test-support.js";

it("Git history keeps a forgotten message erased after an offline stale push", async (t) => {
  const files = gitHistoryFixture(t);
  files.device("a");
  await files.memory((db) => {
    upsertSession(db, { sessionId: "shared", harness: "claude-code" });
    insertMessage(db, {
      uuid: "forgotten-message",
      sessionId: "shared",
      type: "user",
      content: "erasedmarker private history",
    });
  });
  files.push();

  files.device("b");
  files.pull();
  files.device("a");
  assert.equal((await files.memory((db) => forgetMemory(db, "forgotten-message"))).ok, true);
  files.push();

  files.device("b");
  await files.memory((db) => {
    assert.equal(searchMessages(db, "erasedmarker").length, 1, "writer is still stale");
    insertMessage(db, {
      uuid: "late-message",
      sessionId: "shared",
      type: "assistant",
      content: "latewriter retained history",
    });
  });
  files.push();

  files.device("c");
  files.pull();
  await files.memory((db) => {
    assert.equal(searchMessages(db, "erasedmarker").length, 0);
    assert.equal(searchMessages(db, "latewriter").length, 1);
    assert.equal(
      (
        db
          .prepare("SELECT COUNT(*) AS count FROM memory_tombstones WHERE uuid = ?")
          .get("forgotten-message") as { count: number }
      ).count,
      1,
    );
  });
});

it("fresh Git pull retains both offline task edits and repeated pull preserves their conflict", async (t) => {
  const files = await commonGitTask(t);
  const { id, origin } = files;
  const revisions = [];
  for (const [device, title] of [
    ["a", "Check Claude sandbox receipt"],
    ["b", "Check Codex sandbox receipt"],
  ] as const) {
    files.device(device);
    const result = await files.memory((db) =>
      palResolve(db, id, {
        expectedFrontier: origin.frontier,
        choice: { state: { ...origin.heads[0].state, title } },
      }),
    );
    assert.equal(result.status, "applied");
    assert.ok(result.view);
    revisions.push(result.view.heads[0]);
    files.push();
  }

  files.device("c");
  const pulled = files.pull();
  assert.equal(pulled.pendingStateDifferences, 1);
  assert.deepEqual(pulled.pendingDifferenceIds, [id]);
  const received = await files.memory((db) => palShow(db, id, { history: true }));
  assert.ok(received);
  assert.equal(received.syncId, origin.syncId);
  assert.deepEqual(received.origin, origin.origin);
  assert.equal(received.conflict, true);
  assert.deepEqual(
    received.heads,
    revisions.sort((a, b) => a.id.localeCompare(b.id)),
  );
  assert.equal(received.history?.length, 3);
  assert.ok(received.history?.some((revision) => revision.id === origin.heads[0].id));
  assert.deepEqual(
    await files.memory((db) =>
      palList(db, { conflictsOnly: true, allDevices: true, readOnly: true }).map((row) => row.id),
    ),
    [id],
  );

  const repeated = files.pull();
  assert.equal(repeated.pending, 0);
  assert.equal(repeated.pendingStateDifferences, 1);
  assert.deepEqual(repeated.pendingDifferenceIds, [id]);
  assert.deepEqual(await files.memory((db) => palShow(db, id, { history: true })), received);
});
