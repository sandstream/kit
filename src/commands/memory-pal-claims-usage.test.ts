import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { it } from "node:test";
import { fixture } from "../memory/pal-cli.test-support.js";
import type { PalView } from "../memory/pal-revisions.js";
import { CLAUDE, CODEX, FRONTIER, rejectedJson } from "./memory-pal-claims.test-support.js";

it("CLI ownership accepts existing global flags and emits a human receipt", async (t) => {
  const { cli, invoke } = await fixture(t, "claims-device");
  await cli("add", "Inspect global flags");
  const [{ id }] = JSON.parse(await cli("list", "--json"));
  const before: PalView = JSON.parse(await cli("show", id, "--json"));
  const claimed = JSON.parse(
    await invoke(
      [
        "claim",
        id,
        "--harness=claude-code",
        "--session=claude-session",
        `--expect=${before.frontier}`,
        "--env",
        "staging",
        "--json",
      ],
      ["--non-interactive"],
    ),
  );
  assert.equal(claimed.status, "applied");
  const human = await invoke(
    ["renew", id, ...CLAUDE, "--expect", claimed.view.frontier, "--non-interactive"],
    ["--env=staging"],
  );
  assert.match(human, /: applied/);
  assert.match(human, /frontier: [a-f0-9]{64}/);
  assert.match(human, /device=claims-device; harness=claude-code; session=claude-session/);
});

it("read-only mode refuses all claim lifecycle commands before creating memory", async (t) => {
  const { cli, dbPath } = await fixture(t);
  for (const action of ["claim", "renew", "takeover", "done", "release", "snooze", "reopen"]) {
    await assert.rejects(
      cli(action, "missing", ...CLAUDE, "--expect", FRONTIER, "--read-only"),
      /read-only mode active/,
    );
    assert.equal(existsSync(dbPath), false);
  }
});

it("CLI transition usage errors leave absent memory absent", async (t) => {
  const { cli, dbPath } = await fixture(t);
  for (const args of [
    ["done"],
    ["release", "missing", "extra"],
    ["reopen", "missing", "--expect", "bad-frontier"],
    ["done", "missing", "--expect", FRONTIER, "--expect", FRONTIER],
    ["done", "missing", "--session", "unpaired"],
    ["release", "missing", "--scope", "unexpected"],
    ["snooze", "missing", "0"],
    ["snooze", "missing", "0.5"],
    ["snooze", "missing", "NaN"],
    ["snooze", "missing", "2", "extra"],
  ]) {
    const result = await rejectedJson(cli(...args, "--json"), 2);
    assert.equal(result.ok, false);
    assert.equal(existsSync(dbPath), false);
  }
});

it("CLI claim returns an owner receipt and completion rejects another session", async (t) => {
  const { cli } = await fixture(t, "claims-device");
  await cli("add", "Finish receipt review");
  const [{ id }] = JSON.parse(await cli("list", "--json"));
  const before: PalView = JSON.parse(await cli("show", id, "--json"));
  const claimed = JSON.parse(
    await cli("claim", id, "reviewer", ...CLAUDE, "--expect", before.frontier, "--json"),
  );
  assert.equal(claimed.status, "applied");
  assert.notEqual(claimed.view.frontier, before.frontier);
  assert.deepEqual(claimed.view.heads[0].state.claim_owner, {
    device: "claims-device",
    harness: "claude-code",
    session: "claude-session",
  });
  assert.equal(claimed.view.heads[0].state.claimed_by, "reviewer");
  const human = await cli("show", id);
  assert.match(human, /frontier: [a-f0-9]{64}/);
  assert.match(human, /device=claims-device; harness=claude-code; session=claude-session/);
  assert.equal(
    (await rejectedJson(cli("done", id, ...CODEX, "--expect", claimed.view.frontier, "--json")))
      .status,
    "not-owner",
  );
  assert.deepEqual(JSON.parse(await cli("show", id, "--json")), claimed.view);
  const closed = JSON.parse(
    await cli("done", id, ...CLAUDE, "--expect", claimed.view.frontier, "--json"),
  );
  assert.equal(closed.status, "applied");
  assert.equal(JSON.parse(await cli("show", id, "--json")).heads[0].state.status, "closed");
});
