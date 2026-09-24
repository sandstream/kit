import assert from "node:assert/strict";
import { it } from "node:test";
import { fixture } from "./backup.test-support.js";
import { openMemoryDb } from "./db.js";
import { mergeDb } from "./merge.js";
import {
  palAdd,
  palAutoVerify,
  palConfigure,
  palDone,
  palList,
  palReopen,
  palShow,
  palSnooze,
} from "./pal.js";
import { replicas } from "./pal-causal.test-support.js";

it("an observed remote completion returns to its origin without becoming a snapshot conflict", (t) => {
  const { src, dest, track } = fixture(t);
  const previousDevice = process.env.KIT_DEVICE_ID;
  t.after(() => {
    if (previousDevice === undefined) delete process.env.KIT_DEVICE_ID;
    else process.env.KIT_DEVICE_ID = previousDevice;
  });
  process.env.KIT_DEVICE_ID = "causal-device-a";
  const a = track(openMemoryDb(src));
  const id = palAdd(a, { title: "Check sandbox receipt" });
  const [origin] = palList(a, { readOnly: true });

  process.env.KIT_DEVICE_ID = "causal-device-b";
  const b = track(openMemoryDb(dest));
  assert.equal(mergeDb(b, src).pending, 1);
  assert.equal(palDone(b, id), true);
  const [completed] = palList(b, { status: "closed", allDevices: true, readOnly: true });
  assert.equal(completed.sync_id, origin.sync_id);

  process.env.KIT_DEVICE_ID = "causal-device-a";
  const joined = mergeDb(a, dest);
  assert.equal(joined.pendingStateDifferences, 0);
  const [returned] = palList(a, { status: "closed", readOnly: true });
  assert.equal(returned?.sync_id, origin.sync_id);
  assert.equal(returned.origin_device, "causal-device-a");
  assert.equal(returned.origin_root, origin.origin_root);
  assert.equal(returned.closed_at, completed.closed_at);
  assert.equal(mergeDb(a, dest).pendingStateDifferences, 0);
  assert.equal(palReopen(a, id), true);
  process.env.KIT_DEVICE_ID = "causal-device-b";
  assert.equal(mergeDb(b, src).pendingStateDifferences, 0);
  assert.equal(palList(b, { allDevices: true, readOnly: true })[0]?.status, "open");
  assert.equal(palSnooze(b, id, 3), true);
  process.env.KIT_DEVICE_ID = "causal-device-a";
  assert.equal(mergeDb(a, dest).pendingStateDifferences, 0);
  assert.equal(palList(a, { status: "snoozed", readOnly: true })[0]?.id, id);
});

it("new remote revisions reset verification passes even when the final state is identical", async (t) => {
  const { a, b, id, src, dest, device } = replicas(t);
  device("a");
  palConfigure(a, id, { type: "file-exists", path: src });
  const originalState = palShow(a, id)!.heads[0].state;
  assert.deepEqual((await palAutoVerify(a, 2)).closed, []);
  assert.equal(palList(a, { readOnly: true })[0]?.verify_passes, 1);
  device("b");
  palDone(b, id);
  palReopen(b, id);
  assert.deepEqual(palShow(b, id)!.heads[0].state, originalState);
  device("a");
  mergeDb(a, dest);
  assert.equal(palList(a, { readOnly: true })[0]?.verify_passes, 0);
  assert.deepEqual((await palAutoVerify(a, 2)).closed, []);
  assert.equal(palList(a, { readOnly: true })[0]?.verify_passes, 1);
  mergeDb(a, dest);
  assert.equal(
    palList(a, { readOnly: true })[0]?.verify_passes,
    1,
    "duplicate import preserves fresh passes",
  );
  assert.deepEqual((await palAutoVerify(a, 2)).closed, [id]);
});
