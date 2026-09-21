import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { it } from "node:test";
import * as pal from "./pal.js";
import { openMemoryDb } from "./db.js";
import { mergeDb } from "./merge.js";
import { replicas } from "./pal-causal.test-support.js";
import { scanDbForSecrets } from "./scan.js";

it("forget removes current and historical text and deletion survives stale reimport and forwarding", (t) => {
  const { a, b, id, src, dest, dir, track, device } = replicas(t);
  const before = pal.palShow(a, id)!;
  device("a");
  pal.palResolve(a, id, {
    expectedFrontier: before.frontier,
    choice: { state: { ...before.heads[0].state, detail: "sk_live_" + "H".repeat(24) } },
  });
  assert.equal(scanDbForSecrets(a)[0]?.confidence, "high");
  const current = pal.palShow(a, id)!;
  assert.equal(pal.palForget(a, id, { expectedFrontier: before.frontier }).status, "stale");
  const proof = pal.palForget(a, id, { expectedFrontier: current.frontier });
  assert.deepEqual(proof, {
    status: "applied",
    syncId: current.syncId,
    projectionGone: true,
    historyGone: true,
    tombstoned: true,
    ok: true,
  });
  assert.equal(pal.palShow(a, id, { history: true }), null);
  assert.deepEqual(scanDbForSecrets(a), []);
  mergeDb(a, dest);
  assert.equal(pal.palShow(a, id), null);
  device("b");
  mergeDb(b, src);
  assert.equal(pal.palShow(b, id), null);
  const third = track(openMemoryDb(join(dir, "third.db")));
  device("c");
  mergeDb(third, dest);
  mergeDb(third, src);
  assert.equal(pal.palShow(third, id), null);
  assert.equal(pal.palForget(a, id, { expectedFrontier: current.frontier }).status, "missing");
});

it("reimporting the same legacy ledger cannot recreate a forgotten task", (t) => {
  const { a, b, dir, src } = replicas(t);
  const path = join(dir, "legacy.jsonl");
  writeFileSync(path, JSON.stringify({ id: "legacy-erasure", title: "Forget old follow-up" }));
  assert.equal(pal.importLegacyLedger(a, path).imported, 1);
  assert.equal(pal.importLegacyLedger(b, path).imported, 1);
  const view = pal.palShow(a, "legacy-erasure")!;
  assert.equal(pal.palForget(a, view.id, { expectedFrontier: view.frontier }).ok, true);
  assert.equal(pal.importLegacyLedger(a, path).imported, 0);
  assert.equal(pal.palShow(a, view.id), null);
  mergeDb(b, src);
  assert.equal(pal.palShow(b, view.id), null);
});
