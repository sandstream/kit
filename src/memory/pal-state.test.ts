import { it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { openMemoryDb } from "./db.js";
import { palAdd, palDone, palList, palRelease, palReopen, palSnooze } from "./pal.js";
import { claimTask, legacyPalDb, setPalClock, withPalDevice } from "./pal-fixture.test-support.js";

function fixture(t: TestContext) {
  const previous = process.env.KIT_DEVICE_ID;
  process.env.KIT_DEVICE_ID = "pal-lifecycle-fixture";
  const db = openMemoryDb(":memory:");
  t.after(() => {
    db.close();
    if (previous === undefined) delete process.env.KIT_DEVICE_ID;
    else process.env.KIT_DEVICE_ID = previous;
  });
  const row = (id: string) => db.prepare("SELECT * FROM pending_actions WHERE id = ?").get(id)!;
  const add = (title: string) => palAdd(db, { title });
  return { db, row, add };
}

it("an expired snooze returns to open without reviving future, claimed or closed work", (t) => {
  const { db, row, add } = fixture(t);
  const due = add("due");
  const future = add("future");
  const claimed = add("claimed");
  const closed = add("closed");
  palSnooze(db, due, 1);
  palSnooze(db, future, 1);
  claimTask(db, claimed, "another-agent");
  palDone(db, closed);
  const original = row(due);
  setPalClock(db, due, { snooze_until: "2000-01-01T00:00:00Z" });
  assert.deepEqual(
    palList(db).map((action) => action.id),
    [due],
  );
  assert.equal(row(due).snooze_until, null);
  for (const field of ["sync_id", "origin_id", "origin_device", "origin_root", "created_at"]) {
    assert.equal(row(due)[field], original[field]);
  }
  assert.equal(row(future).status, "snoozed");
  assert.equal(row(claimed).status, "claimed");
  assert.equal(row(closed).status, "closed");
  const recovered = row(due);
  palList(db);
  assert.deepEqual(row(due), recovered);
});

it("a snooze can be released early, without resurrecting a closed item", (t) => {
  const { db, row, add } = fixture(t);
  const id = add("early handoff");
  palSnooze(db, id, 7);
  assert.equal(palRelease(db, id), true);
  assert.equal(row(id).status, "open");
  assert.equal(row(id).snooze_until, null);
  palDone(db, id);
  assert.equal(palRelease(db, id), false);
  assert.equal(palSnooze(db, id, 7), false);
  assert.equal(row(id).status, "closed");
});

it("invalid snooze durations cannot mutate or indefinitely hide an action", (t) => {
  const { db, row, add } = fixture(t);
  const id = add("invalid duration");
  const original = row(id);
  for (const days of [
    NaN,
    Infinity,
    -Infinity,
    0,
    -1,
    0.5,
    Number.MAX_SAFE_INTEGER + 1,
    10_000_000,
  ]) {
    assert.throws(() => palSnooze(db, id, days), RangeError);
    assert.deepEqual(row(id), original);
  }
});

it("read-only listing leaves overdue task state untouched", (t) => {
  const { db, row, add } = fixture(t);
  const id = add("read-only view");
  palSnooze(db, id, 1);
  setPalClock(db, id, { snooze_until: "2000-01-01T00:00:00Z" });
  const before = row(id);
  palList(db, { readOnly: true });
  assert.deepEqual(row(id), before);
  palList(db, { reapStale: false });
  assert.deepEqual(row(id), before);
});

it("listing treats claim age as advisory on both local and foreign devices", (t) => {
  const { db, row, add } = fixture(t);
  for (const device of ["pal-lifecycle-fixture", "foreign-device"]) {
    const id = withPalDevice(device, () => {
      const id = add(`${device} old claim`);
      claimTask(db, id, "review-session");
      setPalClock(db, id, { claimed_at: "2000-01-01T00:00:00Z" });
      return id;
    });
    const before = row(id);
    for (const options of [{}, { allDevices: true }, { readOnly: true }]) {
      assert.ok(palList(db, options).every((action) => action.id !== id));
      assert.deepEqual(row(id), before);
    }
    assert.ok(
      palList(db, { status: "claimed", allDevices: true }).some((action) => action.id === id),
    );
    assert.deepEqual(row(id), before);
  }
});

it("explicit reopen resets closure state and retains the task's provenance", (t) => {
  const { db, row, add } = fixture(t);
  const id = add("resume closed work");
  const original = row(id);
  assert.equal(palReopen(db, id), false);
  const claim = claimTask(db, id, "reviewer");
  palSnooze(db, id, 7, claim);
  palDone(db, id);
  assert.equal(row(id).snooze_until, null);
  assert.equal(row(id).claimed_by, null);
  assert.equal(palReopen(db, id), true);
  assert.deepEqual(row(id), original);
  assert.equal(palReopen(db, id), false);
  assert.equal(palReopen(db, "missing"), false);
});

it("automatic reactivation respects project and explicit local recall assignment", (t) => {
  const { db, row } = fixture(t);
  const local = withPalDevice("foreign", () =>
    palAdd(db, { title: "mapped local task", scope: "remote" }),
  );
  const other = withPalDevice("foreign", () =>
    palAdd(db, { title: "other project", scope: "remote" }),
  );
  for (const id of [local, other]) {
    palSnooze(db, id, 1);
    db.prepare(
      `UPDATE pending_actions SET recall_device='pal-lifecycle-fixture', recall_scope=?
      WHERE id=?`,
    ).run(id === local ? "local" : "other", id);
    setPalClock(db, id, { snooze_until: "2000-01-01T00:00:00Z" });
  }
  assert.deepEqual(
    palList(db, { scope: "local" }).map((action) => action.id),
    [local],
  );
  assert.equal(row(other).status, "snoozed");
  assert.equal(row(local).origin_device, "foreign");
  assert.equal(row(local).scope, "remote");
});

it("legacy missing or malformed snooze deadlines cannot hide local tasks forever", (t) => {
  const db = legacyPalDb(t, [
    { id: "missing", title: "legacy deadline", status: "snoozed", snooze_until: null },
    { id: "malformed", title: "legacy deadline", status: "snoozed", snooze_until: "not-a-date" },
  ]);
  withPalDevice("pal-lifecycle-fixture", () => {
    for (const id of ["missing", "malformed"]) {
      assert.ok(palList(db).some((action) => action.id === id));
      assert.equal(palList(db).find((action) => action.id === id)?.snooze_until, null);
    }
  });
});
