import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { mergeDb } from "./merge.js";
import {
  palAutoVerify,
  palConfigure,
  palDone,
  palList,
  palResolve,
  palShow,
  palSyncFindings,
  importLegacyLedger,
} from "./pal.js";
import { replicas } from "./pal-causal.test-support.js";

it("legacy ledger import records an observation before any local transition", (t) => {
  const { a, b, src, dir } = replicas(t);
  const file = join(dir, "legacy.jsonl");
  writeFileSync(file, JSON.stringify({ id: "legacy", title: "Legacy follow-up", status: "open" }));
  assert.equal(importLegacyLedger(a, file).imported, 1);
  const imported = palShow(a, "legacy")!;
  assert.equal(imported.heads[0].observed, true);
  assert.deepEqual(imported.heads[0].parents, []);
  assert.equal(palDone(a, "legacy"), true);
  assert.equal(importLegacyLedger(a, file).imported, 0);
  mergeDb(b, src);
  assert.equal(palShow(b, "legacy")?.heads[0].state.status, "closed");
});

it("automatic completion is recorded and returns to the originating replica", async (t) => {
  const { a, b, id, device, src, dest } = replicas(t);
  device("b");
  palConfigure(b, id, { type: "file-exists", path: src });
  assert.deepEqual((await palAutoVerify(b, 1)).closed, [id]);
  assert.equal(palShow(b, id)?.heads[0].state.status, "closed");
  device("a");
  assert.equal(mergeDb(a, dest).pendingStateDifferences, 0);
  assert.equal(palShow(a, id)?.heads[0].state.status, "closed");
});

it("scanner finding creation, refresh, closure and recurrence survive repeated exchange", (t) => {
  const { a, b, device, src, dest } = replicas(t);
  device("a");
  palSyncFindings(a, "sandbox", [{ dedupKey: "receipt", title: "Receipt missing" }]);
  const id = palList(a).find(({ kind }) => kind === "finding")!.id;
  device("b");
  mergeDb(b, src);
  assert.equal(palShow(b, id)?.heads[0].state.title, "Receipt missing");
  device("a");
  palSyncFindings(a, "sandbox", [{ dedupKey: "receipt", title: "Receipt still missing" }]);
  palSyncFindings(a, "sandbox", []);
  device("b");
  mergeDb(b, src);
  assert.equal(palShow(b, id)?.heads[0].state.status, "closed");
  device("a");
  palSyncFindings(a, "sandbox", [{ dedupKey: "receipt", title: "Receipt regressed" }]);
  device("b");
  mergeDb(b, src);
  assert.equal(palShow(b, id)?.heads[0].state.title, "Receipt regressed");
  device("a");
  assert.equal(mergeDb(a, dest).pendingStateDifferences, 0);
  assert.deepEqual(palShow(a, id), palShow(b, id));
});

it("a conflict remains visible in open work and cannot be auto-verified or reaped", async (t) => {
  const { a, b, id, device, src, dest } = replicas(t);
  device("a");
  palConfigure(a, id, { type: "file-exists", path: src });
  palDone(a, id);
  device("b");
  const before = palShow(b, id)!;
  palResolve(b, id, {
    expectedFrontier: before.frontier,
    choice: { state: { ...before.heads[0].state, status: "snoozed", snooze_until: "2000-01-01" } },
  });
  device("a");
  mergeDb(a, dest);
  const conflicted = palShow(a, id, { history: true });
  const projected = palList(a, { conflictsOnly: true, readOnly: true });
  assert.deepEqual(
    palList(a, { conflictsOnly: true }).map(({ id }) => id),
    [id],
  );
  assert.deepEqual(palList(a), projected);
  assert.equal(projected[0].state_conflict, 1);
  assert.deepEqual(palShow(a, id, { history: true }), conflicted);
  const result = await palAutoVerify(a, 1);
  assert.equal(result.checked, 0);
  assert.equal(result.unverified[0]?.reason, "state-conflict");
  assert.deepEqual(palShow(a, id, { history: true }), conflicted);
});
