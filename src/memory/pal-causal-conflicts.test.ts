import assert from "node:assert/strict";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { openMemoryDb } from "./db.js";
import { mergeDb } from "./merge.js";
import { palDone, palList, palShow, palSnooze } from "./pal.js";
import { claimTask, seedPreFixClaimConflict, setPalClock } from "./pal-fixture.test-support.js";
import { replicas } from "./pal-causal.test-support.js";
import * as pal from "./pal.js";

it("import refuses unrecorded local state instead of silently replacing it", (t) => {
  const { b, id, src } = replicas(t);
  // A database owner can remove SQL guards. Import must still detect the corrupted projection.
  b.exec("DROP TRIGGER pal_state_update");
  b.prepare("UPDATE pending_actions SET title='unrecorded local edit' WHERE id=?").run(id);
  assert.throws(() => mergeDb(b, src), /unrecorded state/i);
  assert.equal(
    pal.palList(b, { allDevices: true, readOnly: true })[0]?.title,
    "unrecorded local edit",
  );
});

it("concurrent alternatives remain inspectable and block ordinary completion after forwarding", (t) => {
  const { a, b, id, device, src, dest, dir, track } = replicas(t);
  device("a");
  palDone(a, id);
  device("b");
  palSnooze(b, id, 3);
  device("a");
  assert.equal(mergeDb(a, dest).pendingStateDifferences, 1);
  const view = palShow(a, id)!;
  assert.equal(view.conflict, true);
  assert.deepEqual(view.heads.map(({ state }) => state.status).sort(), ["closed", "snoozed"]);
  assert.throws(() => palDone(a, id), /unresolved state conflicts/);
  assert.deepEqual(palShow(a, id), view);

  const c = track(openMemoryDb(join(dir, "third.db")));
  device("c");
  assert.equal(mergeDb(c, src).pendingStateDifferences, 1);
  assert.deepEqual(palShow(c, id), view);
  assert.equal(mergeDb(c, dest).pendingStateDifferences, 1);
  assert.deepEqual(palShow(c, id), view);
});

it("identical labels and timestamps cannot hide competing offline claims", (t) => {
  const { a, b, id, device, dest } = replicas(t);
  // A cloned identity can produce equal states, but its offline events still compete.
  device("a");
  for (const db of [a, b]) {
    claimTask(db, id, "release-agent");
    setPalClock(db, id, { claimed_at: "2030-01-01 00:00:00" });
  }
  assert.deepEqual(palShow(a, id)!.heads[0].state, palShow(b, id)!.heads[0].state);
  device("a");
  assert.equal(mergeDb(a, dest).pendingStateDifferences, 1);
  const view = palShow(a, id)!;
  assert.equal(view.conflict, true);
  assert.equal(view.heads.length, 2);
  assert.throws(() => palDone(a, id), /unresolved state conflicts/);
});

function previouslyHiddenClaims(t: TestContext) {
  const f = replicas(t);
  f.device("a");
  for (const db of [f.a, f.b]) {
    claimTask(db, f.id, "release-agent");
    setPalClock(db, f.id, { claimed_at: "2000-01-01 00:00:00" });
  }
  f.device("a");
  mergeDb(f.a, f.dest);
  seedPreFixClaimConflict(f.a, f.id);
  return f;
}

it("read-only and ordinary lists expose formerly hidden claims without reaping or changing history", (t) => {
  const { a, id } = previouslyHiddenClaims(t);
  const before = palShow(a, id, { history: true });
  const changes = a.prepare("SELECT total_changes() AS n").get();
  for (const opts of [{ readOnly: true }, { conflictsOnly: true, readOnly: true }, {}]) {
    const items = palList(a, opts);
    assert.equal(items.length, 1);
    assert.equal(items[0].id, id);
    assert.equal(items[0].state_conflict, 1);
  }
  assert.deepEqual(palShow(a, id, { history: true }), before);
  assert.deepEqual(a.prepare("SELECT total_changes() AS n").get(), changes);
});

it("reopening repairs the old conflict flag without inventing a new revision", (t) => {
  const { a, id, src, track } = previouslyHiddenClaims(t);
  const before = palShow(a, id, { history: true });
  const reopened = track(openMemoryDb(src));
  assert.equal(
    reopened.prepare("SELECT state_conflict FROM pending_actions WHERE id=?").get(id)
      ?.state_conflict,
    1,
  );
  assert.deepEqual(palShow(reopened, id, { history: true }), before);
  assert.equal(palList(reopened, { conflictsOnly: true })[0]?.id, id);
});

it("merging two concurrent descendants while retaining their ancestor remains forwardable", (t) => {
  const { a, b, id, device, src, dest, dir, track } = replicas(t);
  const cPath = join(dir, "third.db");
  const c = track(openMemoryDb(cPath));
  device("c");
  mergeDb(c, src);
  palSnooze(c, id, 3);
  device("b");
  palDone(b, id);
  mergeDb(b, cPath);
  device("a");
  assert.equal(mergeDb(a, dest).pendingStateDifferences, 1);
  device("c");
  assert.equal(mergeDb(c, src).pendingStateDifferences, 1);
  assert.equal(palShow(c, id)?.heads.length, 2);
});

it("expected-frontier resolution converges, while a previously unseen branch restores conflict", (t) => {
  const { a, b, id, device, src, dest, dir, track } = replicas(t);
  const cPath = join(dir, "late.db");
  const c = track(openMemoryDb(cPath));
  mergeDb(c, src);
  device("a");
  palDone(a, id);
  device("b");
  palSnooze(b, id, 3);
  device("a");
  mergeDb(a, dest);
  const before = palShow(a, id)!;
  const chosen = before.heads.find(({ state }) => state.status === "closed")!;
  const result = pal.palResolve(a, id, {
    expectedFrontier: before.frontier,
    choice: { revision: chosen.id },
  });
  assert.equal(result.status, "applied");
  const resolved = palShow(a, id)!;
  assert.equal(resolved.conflict, false);
  assert.equal(resolved.heads.length, 1);
  assert.deepEqual(resolved.heads[0].parents, before.heads.map(({ id }) => id).sort());
  assert.deepEqual(resolved.heads[0].state, chosen.state);
  device("b");
  assert.equal(mergeDb(b, src).pendingStateDifferences, 0);
  assert.deepEqual(palShow(b, id), resolved);

  device("c");
  palSnooze(c, id, 7);
  device("a");
  assert.equal(mergeDb(a, cPath).pendingStateDifferences, 1);
  assert.equal(palShow(a, id)?.heads.length, 2);
  assert.throws(() => palDone(a, id), /unresolved state conflicts/);
});

it("stale frontier cannot resolve or complete work changed after inspection", (t) => {
  const { a, id, device } = replicas(t);
  device("a");
  const before = palShow(a, id)!;
  palSnooze(a, id, 2);
  const current = palShow(a, id, { history: true });
  assert.equal(
    pal.palResolve(a, id, {
      expectedFrontier: before.frontier,
      choice: { revision: before.heads[0].id },
    }).status,
    "stale",
  );
  assert.deepEqual(palShow(a, id, { history: true }), current);
  assert.throws(() => palDone(a, id, { expectedFrontier: before.frontier }), /frontier.*changed/i);
  assert.deepEqual(palShow(a, id, { history: true }), current);
});
