import assert from "node:assert/strict";
import { it } from "node:test";
import { palClaim, palDone, palRenew, palShow, palTakeover } from "./pal.js";
import { replicas } from "./pal-causal.test-support.js";

it("claim, renewal and takeover fail atomically when history storage refuses the event", (t) => {
  const { a, id, device } = replicas(t);
  device("a");
  const owner = { device: "causal-device-a", harness: "claude-code", session: "original" };
  for (const operation of [palClaim, palRenew, palTakeover]) {
    const before = palShow(a, id, { history: true })!;
    a.exec(`CREATE TEMP TRIGGER reject_claim_revision BEFORE INSERT ON pal_revisions
      BEGIN SELECT RAISE(ABORT, 'fixture history unavailable'); END`);
    try {
      assert.throws(
        () => operation(a, id, { owner, expectedFrontier: before.frontier }),
        /fixture history unavailable/,
      );
    } finally {
      a.exec("DROP TRIGGER reject_claim_revision");
    }
    assert.deepEqual(palShow(a, id, { history: true }), before);
    assert.throws(() => a.exec("UPDATE pending_actions SET claim_owner=NULL"), /causal writer/i);
    assert.equal(operation(a, id, { owner, expectedFrontier: before.frontier }).status, "applied");
  }
});

it("caller rollback invalidates the provisional takeover receipt and retains the original owner", (t) => {
  const { a, id, device } = replicas(t);
  device("a");
  const owner = { device: "causal-device-a", harness: "claude-code", session: "original" };
  const successor = { ...owner, harness: "codex", session: "successor" };
  const claimed = palClaim(a, id, { owner, expectedFrontier: palShow(a, id)!.frontier });
  const before = palShow(a, id, { history: true });
  let provisional: string;
  a.exec("BEGIN");
  try {
    const taken = palTakeover(a, id, {
      owner: successor,
      expectedFrontier: claimed.view!.frontier,
    });
    assert.equal(taken.status, "applied");
    provisional = taken.view!.frontier;
    assert.deepEqual(taken.view!.heads[0].state.claim_owner, successor);
  } finally {
    a.exec("ROLLBACK");
  }
  assert.deepEqual(palShow(a, id, { history: true }), before);
  assert.throws(() => palDone(a, id, { owner: successor, expectedFrontier: provisional }), {
    code: "stale",
  });
  assert.equal(palDone(a, id, { owner, expectedFrontier: claimed.view!.frontier }), true);
});
