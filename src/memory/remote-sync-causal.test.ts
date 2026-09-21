import assert from "node:assert/strict";
import { join } from "node:path";
import { it } from "node:test";
import {
  palAdd,
  palAutoVerify,
  palClaim,
  palConfigure,
  palDone,
  palForget,
  palList,
  palResolve,
  palShow,
  palSnooze,
  palTakeover,
} from "./pal.js";
import { commonGitTask, gitHistoryFixture } from "./remote-sync-causal.test-support.js";
import type { PalRevision } from "./pal-revisions.js";

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

it("offline Claude and Codex claims remain contested through Git until explicit takeover", async (t) => {
  const files = await commonGitTask(t);
  const { id, origin } = files;
  const owners = [
    { device: "causal-git-a", harness: "claude-code", session: "claude-fixture-session" },
    { device: "causal-git-b", harness: "codex", session: "codex-fixture-session" },
  ];
  const claims: PalRevision[] = [];
  for (const [device, owner] of [
    ["a", owners[0]],
    ["b", owners[1]],
  ] as const) {
    files.device(device);
    const claimed = await files.memory((db) =>
      palClaim(db, id, { owner, expectedFrontier: origin.frontier }),
    );
    assert.equal(claimed.status, "applied");
    assert.ok(claimed.view);
    assert.deepEqual(claimed.view.heads[0].state.claim_owner, owner);
    claims.push(claimed.view.heads[0]);
    files.push();
  }

  files.device("c");
  const pulled = files.pull();
  assert.equal(pulled.pendingStateDifferences, 1);
  assert.deepEqual(pulled.pendingDifferenceIds, [id]);
  const contested = await files.memory((db) => palShow(db, id, { history: true }));
  assert.ok(contested);
  assert.equal(contested.conflict, true);
  assert.deepEqual(
    contested.heads,
    claims.sort((a, b) => a.id.localeCompare(b.id)),
  );
  assert.equal(contested.history?.length, 3);
  assert.deepEqual(
    contested.heads
      .map((head) => head.state.claim_owner)
      .sort((a, b) => a!.device.localeCompare(b!.device)),
    owners,
  );
  const owner = { device: "causal-git-c", harness: "codex", session: "handoff-fixture-session" };
  await files.memory((db) => {
    assert.throws(() => palDone(db, id, { owner, expectedFrontier: contested.frontier }), {
      code: "conflict",
    });
    assert.deepEqual(palShow(db, id, { history: true }), contested);
  });
  assert.equal(files.pull().pendingStateDifferences, 1);
  assert.deepEqual(await files.memory((db) => palShow(db, id, { history: true })), contested);

  const taken = await files.memory((db) =>
    palTakeover(db, id, { owner, expectedFrontier: contested.frontier, take: claims[0].id }),
  );
  assert.equal(taken.status, "applied");
  assert.ok(taken.view);
  assert.equal(taken.view.conflict, false);
  assert.deepEqual(taken.view.heads[0].state.claim_owner, owner);
  assert.deepEqual(taken.view.heads[0].parents, contested.heads.map((head) => head.id).sort());
  const finalHistory = await files.memory((db) => palShow(db, id, { history: true }));
  assert.equal(finalHistory?.history?.length, 4);
  files.push();

  files.device("d");
  const replayed = files.pull();
  assert.equal(replayed.pendingStateDifferences, 0);
  assert.deepEqual(replayed.pendingDifferenceIds, []);
  assert.deepEqual(await files.memory((db) => palShow(db, id, { history: true })), finalHistory);
});

it("resolution reports zero final conflicts after replaying previously conflicting Git snapshots", async (t) => {
  const files = await commonGitTask(t);
  const { id } = files;
  files.device("a");
  assert.equal(await files.memory((db) => palDone(db, id)), true);
  const completed = await files.memory((db) => palShow(db, id));
  assert.ok(completed);
  files.push();
  files.device("b");
  assert.equal(await files.memory((db) => palSnooze(db, id, 3)), true);
  files.push();

  files.device("c");
  assert.equal(files.pull().pendingStateDifferences, 1);
  const contested = await files.memory((db) => palShow(db, id));
  assert.ok(contested);
  assert.equal(contested.conflict, true);
  assert.equal(contested.heads.length, 2);
  const resolved = await files.memory((db) =>
    palResolve(db, id, {
      expectedFrontier: contested.frontier,
      choice: { revision: completed.heads[0].id },
    }),
  );
  assert.equal(resolved.status, "applied");
  assert.ok(resolved.view);
  assert.equal(resolved.view.conflict, false);
  assert.equal(resolved.view.heads[0].state.status, "closed");
  assert.deepEqual(resolved.view.heads[0].parents, contested.heads.map((head) => head.id).sort());
  const finalHistory = await files.memory((db) => palShow(db, id, { history: true }));
  assert.equal(finalHistory?.history?.length, 4);
  files.push();

  files.device("d");
  const replayed = files.pull();
  assert.equal(replayed.pendingStateDifferences, 0);
  assert.deepEqual(replayed.pendingDifferenceIds, []);
  assert.deepEqual(await files.memory((db) => palShow(db, id, { history: true })), finalHistory);
  assert.deepEqual(
    await files.memory((db) =>
      palList(db, { conflictsOnly: true, allDevices: true, readOnly: true }),
    ),
    [],
  );
  const repeated = files.pull();
  assert.equal(repeated.pending, 0);
  assert.equal(repeated.pendingStateDifferences, 0);
  assert.deepEqual(repeated.pendingDifferenceIds, []);
  assert.deepEqual(await files.memory((db) => palShow(db, id, { history: true })), finalHistory);
});
