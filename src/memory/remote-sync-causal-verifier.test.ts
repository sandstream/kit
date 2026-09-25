import assert from "node:assert/strict";
import { join } from "node:path";
import { it } from "node:test";
import {
  palAdd,
  palAutoVerify,
  palConfigure,
  palForget,
  palList,
  palResolve,
  palShow,
} from "./pal.js";
import { commonGitTask, gitHistoryFixture } from "./remote-sync-causal.test-support.js";

it("Git history never grants verifier authority while an explicit local check survives repeated pull", async (t) => {
  const files = gitHistoryFixture(t);
  const id = await files.memory(async (db) => {
    const created = palAdd(db, {
      title: "Verify local sandbox receipt artifact",
      check: { type: "file-exists", path: join(files.dir, "a", "memory.db") },
    });
    const verified = await palAutoVerify(db, 2);
    assert.equal(verified.checked, 1);
    assert.deepEqual(verified.closed, []);
    const [row] = palList(db, { allDevices: true, readOnly: true });
    assert.equal(row.verify_passes, 1);
    assert.ok(row.verify_grant);
    return created;
  });
  const original = await files.memory((db) => palShow(db, id, { history: true }));
  files.push();

  // Export two independently approved verifier configurations, not only a forwarding copy.
  files.device("b");
  files.pull();
  await files.memory(async (db) => {
    assert.equal((await palAutoVerify(db, 1)).checked, 0);
    assert.equal(
      palConfigure(db, id, { type: "file-exists", path: join(files.dir, "b", "memory.db") }),
      true,
    );
    const verified = await palAutoVerify(db, 2);
    assert.equal(verified.checked, 1);
    assert.deepEqual(verified.closed, []);
    assert.equal(palList(db, { allDevices: true, readOnly: true })[0].verify_passes, 1);
  });
  files.push();

  files.device("c");
  assert.equal(files.pull().pendingStateDifferences, 0);
  await files.memory(async (db) => {
    const [imported] = palList(db, { allDevices: true, readOnly: true });
    assert.equal(imported.id, id);
    assert.equal(imported.kind, "manual");
    assert.equal(imported.verify_check, null);
    assert.equal(imported.verify_grant, null);
    assert.equal(imported.verify_passes, 0);
    const blocked = await palAutoVerify(db, 1);
    assert.equal(blocked.checked, 0);
    assert.deepEqual(blocked.closed, []);
    assert.deepEqual(blocked.reopened, []);
    assert.deepEqual(palShow(db, id, { history: true }), original);
    assert.deepEqual(palList(db, { allDevices: true, readOnly: true }), [imported]);

    assert.equal(
      palConfigure(db, id, { type: "file-exists", path: join(files.dir, "c", "memory.db") }),
      true,
    );
    const firstPass = await palAutoVerify(db, 2);
    assert.equal(firstPass.checked, 1);
    assert.deepEqual(firstPass.closed, []);
    assert.equal(palList(db, { allDevices: true, readOnly: true })[0].verify_passes, 1);
  });
  const repeated = files.pull();
  assert.equal(repeated.pending, 0);
  assert.equal(repeated.pendingStateDifferences, 0);
  await files.memory(async (db) => {
    const [local] = palList(db, { allDevices: true, readOnly: true });
    assert.deepEqual(JSON.parse(local.verify_check!), {
      type: "file-exists",
      path: join(files.dir, "c", "memory.db"),
    });
    assert.equal(local.verify_passes, 1);
    const confirmed = await palAutoVerify(db, 2);
    assert.equal(confirmed.checked, 1);
    assert.deepEqual(confirmed.closed, [id]);
    assert.equal(palShow(db, id)?.heads[0].state.status, "closed");
  });
});

it("Git replay keeps a task forgotten despite a later push from an unaware offline writer", async (t) => {
  const files = await commonGitTask(t);
  const { id, origin } = files;
  files.device("a");
  const forgotten = await files.memory((db) =>
    palForget(db, id, { expectedFrontier: origin.frontier }),
  );
  assert.equal(forgotten.status, "applied");
  assert.equal(forgotten.ok, true);
  assert.equal(await files.memory((db) => palShow(db, id, { history: true })), null);
  files.push();

  files.device("b");
  const stale = await files.memory((db) =>
    palResolve(db, id, {
      expectedFrontier: origin.frontier,
      choice: { state: { ...origin.heads[0].state, title: "Late offline receipt update" } },
    }),
  );
  assert.equal(stale.status, "applied");
  assert.equal(stale.view?.heads[0].state.title, "Late offline receipt update");
  files.push();

  files.device("c");
  for (let attempt = 0; attempt < 2; attempt++) {
    const replayed = files.pull();
    assert.equal(replayed.pendingStateDifferences, 0);
    assert.deepEqual(replayed.pendingDifferenceIds, []);
    assert.equal(await files.memory((db) => palShow(db, id, { history: true })), null);
    assert.deepEqual(
      await files.memory((db) => palList(db, { allDevices: true, readOnly: true })),
      [],
    );
  }
  files.push();

  files.device("b");
  assert.ok(await files.memory((db) => palShow(db, id)));
  assert.equal(files.pull().pendingStateDifferences, 0);
  assert.equal(await files.memory((db) => palShow(db, id, { history: true })), null);
});
