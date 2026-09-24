import assert from "node:assert/strict";
import { it } from "node:test";
import { openMemoryDb } from "./db.js";
import { palAdd, palClaim, palDone, palShow } from "./pal.js";
import * as pal from "./pal.js";
import { withPalDevice } from "./pal-fixture.test-support.js";

it("only the claiming session can complete work with its observed generation", () => {
  withPalDevice("claim-device", () => {
    const db = openMemoryDb(":memory:");
    try {
      const id = palAdd(db, { title: "verify sandbox receipt" });
      const owner = { device: "claim-device", harness: "claude-code", session: "session-a" };
      const claimed = palClaim(db, id, { owner, expectedFrontier: palShow(db, id)!.frontier });
      assert.equal(claimed.status, "applied");
      assert.deepEqual(claimed.view!.heads[0].state.claim_owner, owner);
      assert.deepEqual(
        pal.palList(db, { status: "claimed", readOnly: true })[0].claim_owner,
        owner,
      );
      const before = palShow(db, id, { history: true });
      const expectedFrontier = claimed.view!.frontier;
      assert.throws(
        () =>
          palDone(db, id, {
            owner: { ...owner, harness: "codex", session: "session-b" },
            expectedFrontier,
          }),
        { code: "not-owner" },
      );
      assert.deepEqual(palShow(db, id, { history: true }), before);
      assert.equal(palDone(db, id, { owner, expectedFrontier }), true);
      assert.equal(palShow(db, id)!.heads[0].state.claim_owner, null);
    } finally {
      db.close();
    }
  });
});

it("forgetting claimed work requires the same owner and generation as completion", () => {
  withPalDevice("claim-device", () => {
    const db = openMemoryDb(":memory:");
    try {
      const id = palAdd(db, { title: "private claim" });
      const owner = { device: "claim-device", harness: "codex", session: "owner" };
      const claimed = palClaim(db, id, { owner, expectedFrontier: palShow(db, id)!.frontier });
      const expectedFrontier = claimed.view!.frontier;
      assert.throws(() => pal.palForget(db, id, { expectedFrontier }), { code: "owner-required" });
      assert.throws(
        () => pal.palForget(db, id, { owner: { ...owner, session: "other" }, expectedFrontier }),
        { code: "not-owner" },
      );
      assert.deepEqual(palShow(db, id), claimed.view);
      assert.equal(pal.palForget(db, id, { owner, expectedFrontier }).status, "applied");
      assert.equal(palShow(db, id), null);
    } finally {
      db.close();
    }
  });
});

it("claim and takeover both reject empty display labels without changing ownership", () => {
  withPalDevice("claim-device", () => {
    const db = openMemoryDb(":memory:");
    try {
      const id = palAdd(db, { title: "consistent owner display" });
      const owner = { device: "claim-device", harness: "codex", session: "owner" };
      for (const operation of [palClaim, pal.palTakeover]) {
        const before = palShow(db, id, { history: true })!;
        for (const label of ["", "   "]) {
          assert.throws(
            () => operation(db, id, { owner, expectedFrontier: before.frontier, label }),
            /label must be nonempty/i,
          );
          assert.deepEqual(palShow(db, id, { history: true }), before);
        }
        assert.equal(
          operation(db, id, { owner, expectedFrontier: before.frontier }).status,
          "applied",
        );
      }
    } finally {
      db.close();
    }
  });
});

it("generic resolution cannot manufacture unknown ownership or remove an active claim owner", () => {
  withPalDevice("claim-device", () => {
    const db = openMemoryDb(":memory:");
    try {
      const id = palAdd(db, { title: "use explicit ownership operations" });
      const before = palShow(db, id)!;
      assert.throws(
        () =>
          pal.palResolve(db, id, {
            expectedFrontier: before.frontier,
            choice: {
              state: {
                ...before.heads[0].state,
                status: "claimed",
                claimed_by: "anonymous",
                claim_owner: null,
              },
            },
          }),
        { code: "owner-required" },
      );
      const owner = { device: "claim-device", harness: "codex", session: "owner" };
      const claimed = palClaim(db, id, { owner, expectedFrontier: before.frontier });
      assert.throws(
        () =>
          pal.palResolve(db, id, {
            owner,
            expectedFrontier: claimed.view!.frontier,
            choice: { state: { ...claimed.view!.heads[0].state, claim_owner: null } },
          }),
        { code: "owner-required" },
      );
      assert.deepEqual(palShow(db, id), claimed.view);
    } finally {
      db.close();
    }
  });
});

it("listing old claims and refreshing findings cannot silently revoke session ownership", () => {
  withPalDevice("claim-device", () => {
    const db = openMemoryDb(":memory:");
    try {
      const finding = { dedupKey: "checkout", title: "review checkout" };
      pal.palSyncFindings(db, "claim-test", [finding]);
      const id = pal.palList(db)[0].id;
      db.function("datetime", { varargs: true }, () => "2000-01-01 00:00:00");
      const owner = { device: "claim-device", harness: "codex", session: "active-owner" };
      palClaim(db, id, { owner, expectedFrontier: palShow(db, id)!.frontier });
      const before = palShow(db, id, { history: true });
      assert.deepEqual(pal.palList(db), []);
      assert.equal(pal.palList(db, { status: "claimed" })[0].id, id);
      const scan = pal.palSyncFindings(db, "claim-test", [{ ...finding, title: "new scan text" }]);
      assert.deepEqual(scan.deferred, [id]);
      assert.deepEqual(palShow(db, id, { history: true }), before);
      assert.deepEqual(pal.palSyncFindings(db, "claim-test", []).deferred, [id]);
      assert.deepEqual(palShow(db, id, { history: true }), before);
    } finally {
      db.close();
    }
  });
});

it("explicit takeover replaces the session owner and fences the previous receipt", () => {
  withPalDevice("claim-device", () => {
    const db = openMemoryDb(":memory:");
    try {
      const id = palAdd(db, { title: "continue another harness's payment test" });
      const owner = { device: "claim-device", harness: "claude-code", session: "first" };
      const claimed = palClaim(db, id, { owner, expectedFrontier: palShow(db, id)!.frontier });
      const old = claimed.view!;
      const successor = { ...owner, harness: "codex", session: "second" };
      assert.throws(
        () =>
          pal.palResolve(db, id, {
            owner: successor,
            expectedFrontier: old.frontier,
            choice: { state: { ...old.heads[0].state, claim_owner: successor } },
          }),
        { code: "not-owner" },
      );
      const taken = pal.palTakeover(db, id, { owner: successor, expectedFrontier: old.frontier });
      assert.equal(taken.status, "applied");
      assert.deepEqual(taken.view!.heads[0].state.claim_owner, successor);
      assert.deepEqual(taken.view!.heads[0].parents, [old.heads[0].id]);
      assert.throws(() => pal.palRelease(db, id, { owner, expectedFrontier: old.frontier }), {
        code: "stale",
      });
      assert.throws(() => palDone(db, id, { owner, expectedFrontier: taken.view!.frontier }), {
        code: "not-owner",
      });
      assert.equal(
        pal.palRelease(db, id, { owner: successor, expectedFrontier: taken.view!.frontier }),
        true,
      );
      assert.equal(palShow(db, id)!.heads[0].state.claim_owner, null);
    } finally {
      db.close();
    }
  });
});

it("renewal rotates the generation even when both observations have the same clock value", () => {
  withPalDevice("claim-device", () => {
    const db = openMemoryDb(":memory:");
    try {
      const id = palAdd(db, { title: "long-running checkout test" });
      const owner = { device: "claim-device", harness: "codex", session: "renew-session" };
      const claimed = palClaim(db, id, { owner, expectedFrontier: palShow(db, id)!.frontier });
      const old = claimed.view!;
      // Freeze the actual SQL clock, not revision identities or generation calculation.
      let clockReads = 0;
      db.function("datetime", { varargs: true }, () => {
        clockReads++;
        return old.heads[0].state.claimed_at;
      });
      const renewed = pal.palRenew(db, id, { owner, expectedFrontier: old.frontier });
      assert.equal(renewed.status, "applied");
      assert.ok(clockReads > 0);
      assert.deepEqual(renewed.view!.heads[0].state, old.heads[0].state);
      assert.notEqual(renewed.view!.frontier, old.frontier);
      assert.deepEqual(renewed.view!.heads[0].parents, [old.heads[0].id]);
      assert.throws(() => palDone(db, id, { owner, expectedFrontier: old.frontier }), {
        code: "stale",
      });
      assert.deepEqual(palShow(db, id), renewed.view);
      assert.equal(palDone(db, id, { owner, expectedFrontier: renewed.view!.frontier }), true);
    } finally {
      db.close();
    }
  });
});
