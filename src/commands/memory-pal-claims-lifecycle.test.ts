import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { it } from "node:test";
import { fixture } from "../memory/pal-cli.test-support.js";
import { openMemoryDb } from "../memory/db.js";
import type { PalView } from "../memory/pal-revisions.js";
import { seedLegacyPalDb } from "../memory/pal-fixture.test-support.js";
import { CLAUDE, FRONTIER, rejectedJson } from "./memory-pal-claims.test-support.js";

it("CLI legacy claims keep unknown ownership until explicit takeover", async (t) => {
  const { cli, dbPath } = await fixture(t, "claims-device");
  seedLegacyPalDb(dbPath, [
    {
      id: "legacy",
      title: "Recover older claim",
      status: "claimed",
      claimed_by: "old reviewer",
      claimed_at: "2000-01-01 00:00:00",
    },
  ]);
  openMemoryDb(dbPath).close();
  const before: PalView = JSON.parse(await cli("show", "legacy", "--json"));
  assert.equal(before.heads[0].state.claim_owner ?? null, null);
  assert.match(await cli("show", "legacy"), /unknown legacy session; explicit takeover required/);
  assert.equal(
    (await rejectedJson(cli("done", "legacy", ...CLAUDE, "--expect", before.frontier, "--json")))
      .status,
    "legacy-owner",
  );
  assert.equal(
    (await rejectedJson(cli("forget", "legacy", ...CLAUDE, "--expect", before.frontier, "--json")))
      .status,
    "legacy-owner",
  );
  const claimed = JSON.parse(
    await cli("takeover", "legacy", ...CLAUDE, "--expect", before.frontier, "--json"),
  );
  assert.equal(claimed.status, "applied");
  assert.equal(claimed.view.heads[0].state.claim_owner.session, "claude-session");
  assert.equal(
    JSON.parse(await cli("done", "legacy", ...CLAUDE, "--expect", claimed.view.frontier, "--json"))
      .status,
    "applied",
  );
});

it("CLI refuses missing ownership on claimed transitions without changing the receipt", async (t) => {
  const { cli } = await fixture(t, "claims-device");
  await cli("add", "Keep ownership explicit");
  const [{ id }] = JSON.parse(await cli("list", "--json"));
  const before: PalView = JSON.parse(await cli("show", id, "--json"));
  const claimed = JSON.parse(
    await cli("claim", id, ...CLAUDE, "--expect", before.frontier, "--json"),
  );
  for (const action of ["done", "release", "snooze", "reopen"]) {
    for (const options of [["--expect", claimed.view.frontier], CLAUDE]) {
      assert.equal(
        (await rejectedJson(cli(action, id, ...options, "--json"))).status,
        "owner-required",
      );
    }
  }
  assert.deepEqual(JSON.parse(await cli("show", id, "--json")), claimed.view);
});

it("CLI claim commands validate strict arity, identity pairs and flag values before opening memory", async (t) => {
  const { cli, dbPath } = await fixture(t);
  const required = [...CLAUDE, "--expect", FRONTIER];
  for (const args of [
    ["claim", "missing", ...CLAUDE],
    ["renew", "missing", "label", ...required],
    ["takeover", "missing", "label", "extra", ...required],
    ["claim", "missing", "", ...required],
    ["takeover", "missing", ...required, "--take="],
    ["claim", "missing", ...required, "--take", "a".repeat(32)],
    ["renew", "missing", ...required, "--harness", "other"],
    ["claim", "missing", ...required, "--session", "other"],
    ["takeover", "missing", ...required, "--expect", FRONTIER],
    ["claim", "missing", "--harness", "claude-code", "--session=", "--expect", FRONTIER],
    ["claim", "missing", "--harness=", "--session", "session", "--expect", FRONTIER],
    ["claim", "missing", "--harness", " padded ", "--session", "session", "--expect", FRONTIER],
    [
      "claim",
      "missing",
      "--harness",
      "claude-code",
      "--session",
      "bad\nidentity",
      "--expect",
      FRONTIER,
    ],
    [
      "renew",
      "missing",
      "--harness",
      "claude-code",
      "--session",
      "s".repeat(257),
      "--expect",
      FRONTIER,
    ],
    ["claim", "missing", ...required, "--scope", "unused"],
  ]) {
    assert.equal((await rejectedJson(cli(...args, "--json"), 2)).ok, false);
    assert.equal(existsSync(dbPath), false);
  }
});

it("CLI missing and unchanged claim operations return nonzero with an explicit status", async (t) => {
  const { cli, dbPath } = await fixture(t);
  for (const action of ["claim", "renew", "takeover", "done", "release", "snooze", "reopen"]) {
    assert.equal(
      (await rejectedJson(cli(action, "missing", ...CLAUDE, "--expect", FRONTIER, "--json")))
        .status,
      "missing",
    );
    assert.equal(existsSync(dbPath), false);
  }
  await cli("add", "Unchanged is not applied");
  const [{ id }] = JSON.parse(await cli("list", "--json"));
  const open: PalView = JSON.parse(await cli("show", id, "--json"));
  for (const action of ["renew", "takeover"]) {
    const result = await rejectedJson(
      cli(action, id, ...CLAUDE, "--expect", open.frontier, "--json"),
    );
    assert.equal(result.status, "unchanged");
    assert.deepEqual(result.view, open);
  }
  await cli("done", id);
  const closed: PalView = JSON.parse(await cli("show", id, "--json"));
  const result = await rejectedJson(
    cli("claim", id, ...CLAUDE, "--expect", closed.frontier, "--json"),
  );
  assert.equal(result.status, "unchanged");
  assert.deepEqual(result.view, closed);
});
