import assert from "node:assert/strict";
import { it } from "node:test";
import { palClaim, palDone, palList, palResolve, palShow, palSnooze, palTakeover } from "./pal.js";
import { commonGitTask } from "./remote-sync-causal.test-support.js";
import type { PalRevision } from "./pal-revisions.js";

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
