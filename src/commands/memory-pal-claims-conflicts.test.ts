import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import { fixture } from "../memory/pal-cli.test-support.js";
import type { PalView } from "../memory/pal-revisions.js";
import { openMemoryDb } from "../memory/db.js";
import { mergeDb } from "../memory/merge.js";
import { CLAUDE, CODEX, rejectedJson } from "./memory-pal-claims.test-support.js";

it("CLI takeover transfers ownership explicitly and fences the former owner", async (t) => {
  const { cli } = await fixture(t, "claims-device");
  await cli("add", "Switch harness after review");
  const [{ id }] = JSON.parse(await cli("list", "--json"));
  const before: PalView = JSON.parse(await cli("show", id, "--json"));
  const claimed = JSON.parse(
    await cli("claim", id, ...CLAUDE, "--expect", before.frontier, "--json"),
  );
  const taken = JSON.parse(
    await cli(
      "takeover",
      id,
      "new reviewer",
      ...CODEX,
      "--expect",
      claimed.view.frontier,
      "--json",
    ),
  );
  assert.equal(taken.status, "applied");
  assert.equal(taken.view.heads[0].state.claimed_by, "new reviewer");
  assert.deepEqual(taken.view.heads[0].state.claim_owner, {
    device: "claims-device",
    harness: "codex",
    session: "codex-session",
  });
  assert.match(await cli("list", "--status", "claimed"), /codex-session/);
  assert.equal(
    (await rejectedJson(cli("done", id, ...CLAUDE, "--expect", claimed.view.frontier, "--json")))
      .status,
    "stale",
  );
  for (const action of ["done", "renew", "release", "snooze"]) {
    assert.equal(
      (await rejectedJson(cli(action, id, ...CLAUDE, "--expect", taken.view.frontier, "--json")))
        .status,
      "not-owner",
    );
  }
  assert.deepEqual(JSON.parse(await cli("show", id, "--json")), taken.view);
  assert.equal(
    JSON.parse(await cli("snooze", id, "2", ...CODEX, "--expect", taken.view.frontier, "--json"))
      .status,
    "applied",
  );
  const snoozed: PalView = JSON.parse(await cli("show", id, "--json"));
  assert.equal(snoozed.heads[0].state.status, "snoozed");
  assert.equal(snoozed.heads[0].state.claim_owner, null);
});

async function contestedClaims(t: TestContext) {
  const a = await fixture(t, "claims-device-a");
  const b = await fixture(t, "claims-device-b");
  await a.cli("add", "Resolve offline ownership");
  const [{ id }] = JSON.parse(await a.cli("list", "--json"));
  const before: PalView = JSON.parse(await a.cli("show", id, "--json"));
  const replica = openMemoryDb(b.dbPath);
  try {
    mergeDb(replica, a.dbPath);
  } finally {
    replica.close();
  }
  const claimedA = JSON.parse(
    await a.cli("claim", id, ...CLAUDE, "--expect", before.frontier, "--json"),
  );
  const claimedB = JSON.parse(
    await b.cli("claim", id, ...CODEX, "--expect", before.frontier, "--json"),
  );
  const local = openMemoryDb(a.dbPath);
  try {
    mergeDb(local, b.dbPath);
  } finally {
    local.close();
  }
  const conflict: PalView = JSON.parse(await a.cli("show", id, "--history", "--json"));
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.heads.length, 2);
  return { a, id, conflict, claimedA, claimedB };
}

it("CLI contested takeover requires an explicit current head and preserves both histories", async (t) => {
  const { a, id, conflict, claimedA, claimedB } = await contestedClaims(t);
  for (const [action, choice] of [
    ["resolve", ["--take", claimedA.view.heads[0].id]],
    ["forget", []],
  ] as const) {
    assert.equal(
      (
        await rejectedJson(
          a.cli(action, id, ...CLAUDE, "--expect", conflict.frontier, ...choice, "--json"),
        )
      ).status,
      "conflict",
    );
  }
  assert.equal(
    (await rejectedJson(a.cli("renew", id, ...CLAUDE, "--expect", conflict.frontier, "--json")))
      .status,
    "conflict",
  );
  assert.equal(
    (
      await rejectedJson(
        a.cli("takeover", id, ...CLAUDE, "--expect", conflict.frontier, "--json"),
        2,
      )
    ).ok,
    false,
  );
  assert.equal(
    (
      await rejectedJson(
        a.cli(
          "takeover",
          id,
          ...CLAUDE,
          "--expect",
          conflict.frontier,
          "--take",
          "f".repeat(32),
          "--json",
        ),
        2,
      )
    ).ok,
    false,
  );
  assert.deepEqual(JSON.parse(await a.cli("show", id, "--history", "--json")), conflict);
  const taken = JSON.parse(
    await a.cli(
      "takeover",
      id,
      ...CLAUDE,
      "--expect",
      conflict.frontier,
      "--take",
      claimedB.view.heads[0].id,
      "--json",
    ),
  );
  assert.equal(taken.status, "applied");
  assert.equal(taken.view.conflict, false);
  assert.deepEqual(
    taken.view.heads[0].parents,
    [claimedA.view.heads[0].id, claimedB.view.heads[0].id].sort(),
  );
  assert.equal(taken.view.heads[0].state.claim_owner.device, "claims-device-a");
  assert.equal(
    JSON.parse(await a.cli("show", id, "--history", "--json")).history.length,
    conflict.history!.length + 1,
  );
});
