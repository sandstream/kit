import assert from "node:assert/strict";
import { join } from "node:path";
import { it } from "node:test";
import { openMemoryDb } from "./db.js";
import { mergeDb } from "./merge.js";
import { palClaim, palDone, palRenew, palShow, palTakeover } from "./pal.js";
import { modes } from "./backup.test-support.js";
import { replicas } from "./pal-causal.test-support.js";

it("offline owners contend, explicit takeover joins observed heads, and a late owner restores contention", (t) => {
  const { a, b, id, device, src, dest, dir, track } = replicas(t);
  const cPath = join(dir, "late-owner.db");
  const c = track(openMemoryDb(cPath));
  mergeDb(c, src);
  const aOwner = { device: "causal-device-a", harness: "claude-code", session: "a-session" };
  const bOwner = { device: "causal-device-b", harness: "codex", session: "b-session" };
  device("a");
  const aClaim = palClaim(a, id, { owner: aOwner, expectedFrontier: palShow(a, id)!.frontier });
  device("b");
  palClaim(b, id, { owner: bOwner, expectedFrontier: palShow(b, id)!.frontier });
  device("a");
  assert.equal(mergeDb(a, dest).pendingStateDifferences, 1);
  const contested = palShow(a, id, { history: true })!;
  assert.throws(() => palDone(a, id, { owner: aOwner, expectedFrontier: contested.frontier }), {
    code: "conflict",
  });
  assert.throws(
    () => palTakeover(a, id, { owner: aOwner, expectedFrontier: contested.frontier }),
    /chosen current head/i,
  );
  assert.deepEqual(palShow(a, id, { history: true }), contested);
  const taken = palTakeover(a, id, {
    owner: aOwner,
    expectedFrontier: contested.frontier,
    take: aClaim.view!.heads[0].id,
  });
  assert.equal(taken.status, "applied");
  assert.deepEqual(taken.view!.heads[0].parents, contested.heads.map((head) => head.id).sort());
  assert.equal(taken.view!.conflict, false);
  device("b");
  assert.equal(mergeDb(b, src).pendingStateDifferences, 0);
  assert.deepEqual(palShow(b, id), taken.view);
  assert.throws(() => palDone(b, id, { owner: aOwner, expectedFrontier: taken.view!.frontier }), {
    code: "not-owner",
  });
  assert.equal(mergeDb(b, src).pendingStateDifferences, 0);
  assert.deepEqual(palShow(b, id), taken.view);
  device("c");
  palClaim(c, id, {
    owner: { device: "causal-device-c", harness: "codex", session: "late" },
    expectedFrontier: palShow(c, id)!.frontier,
  });
  device("a");
  assert.equal(mergeDb(a, cPath).pendingStateDifferences, 1);
  assert.equal(palShow(a, id)!.conflict, true);
  assert.equal(palShow(a, id)!.heads.length, 2);
});

it("cloned session identities and equal clocks still produce conflicting offline claims", (t) => {
  const { a, b, id, device, dest } = replicas(t);
  device("a");
  const owner = { device: "causal-device-a", harness: "codex", session: "cloned-session" };
  for (const db of [a, b]) {
    db.function("datetime", { varargs: true }, () => "2030-01-01 00:00:00");
    assert.equal(
      palClaim(db, id, { owner, expectedFrontier: palShow(db, id)!.frontier }).status,
      "applied",
    );
  }
  assert.deepEqual(palShow(a, id)!.heads[0].state, palShow(b, id)!.heads[0].state);
  assert.equal(mergeDb(a, dest).pendingStateDifferences, 1);
  assert.equal(palShow(a, id)!.conflict, true);
});

for (const mode of modes) {
  it(`${mode.name} encrypted forwarding preserves ownership and fences old receipts after return`, (t) => {
    const { a, b, id, device, src, dest, dir } = replicas(t);
    device("a");
    const owner = { device: "causal-device-a", harness: "claude-code", session: "source-session" };
    const claimed = palClaim(a, id, { owner, expectedFrontier: palShow(a, id)!.frontier });
    const original = palShow(a, id, { history: true });
    const blob = join(dir, "owned.enc");
    const imported = join(dir, "imported.db");
    mode.backup(src, blob);
    mode.restore(blob, imported);
    device("b");
    assert.equal(mergeDb(b, imported).pendingStateDifferences, 0);
    assert.deepEqual(palShow(b, id, { history: true }), original);
    assert.throws(() => palDone(b, id, { owner, expectedFrontier: claimed.view!.frontier }), {
      code: "not-owner",
    });
    const nextOwner = {
      device: "causal-device-b",
      harness: "codex",
      session: "destination-session",
    };
    const taken = palTakeover(b, id, {
      owner: nextOwner,
      expectedFrontier: claimed.view!.frontier,
    });
    const renewed = palRenew(b, id, { owner: nextOwner, expectedFrontier: taken.view!.frontier });
    const outbound = join(dir, "returned.enc");
    const returned = join(dir, "returned.db");
    mode.backup(dest, outbound);
    mode.restore(outbound, returned);
    device("a");
    assert.equal(mergeDb(a, returned).pendingStateDifferences, 0);
    assert.deepEqual(palShow(a, id), renewed.view);
    assert.throws(() => palDone(a, id, { owner, expectedFrontier: claimed.view!.frontier }), {
      code: "stale",
    });
    assert.equal(mergeDb(a, returned).pendingStateDifferences, 0);
    assert.deepEqual(palShow(a, id), renewed.view);
    assert.deepEqual(renewed.view!.heads[0].state.claim_owner, nextOwner);
  });
}
