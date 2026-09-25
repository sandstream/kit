import { it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fixture, storedAction } from "./pal-cli.test-support.js";
import type { PendingAction } from "./pal.js";

it("PAL CLI rejects invalid status even with no memory database", async (t) => {
  const { cli, dbPath } = await fixture(t);
  for (const status of ["--status=unknown", "--status=", "--status"]) {
    await assert.rejects(cli("list", "--json", status), { code: 2 });
  }
  assert.equal(existsSync(dbPath), false);
  assert.equal(await cli("list", "--json", "--status=claimed"), "[]\n");
  assert.equal(existsSync(dbPath), false);
});

it("PAL malformed commands and empty identities are usage errors", async (t) => {
  const { cli } = await fixture(t);
  await assert.rejects(cli("unknown"), { code: 2 });
  await assert.rejects(cli("add"), { code: 2 });
  await assert.rejects(cli("reopen", ""), { code: 2 });
  await assert.rejects(cli("snooze", "id", "7", "unexpected"), { code: 2 });
});

it("PAL CLI rejects invalid snooze durations instead of reporting success", async (t) => {
  const { cli, dbPath } = await fixture(t);
  await cli("add", "Duration validation");
  const [action] = JSON.parse(await cli("list", "--json")) as PendingAction[];
  const before = storedAction(dbPath, action.id);
  for (const days of ["NaN", "Infinity", "0", "-1", "0.5", "10000000"]) {
    await assert.rejects(cli("snooze", action.id, days), { code: 2 });
    assert.deepEqual(storedAction(dbPath, action.id), before);
  }
});

it("PAL CLI has a complete early-release, close and explicit reopen path", async (t) => {
  const { cli, dbPath } = await fixture(t);
  await cli("add", "Resume handoff");
  const [action] = JSON.parse(await cli("list", "--json")) as PendingAction[];
  await cli("snooze", action.id, "7");
  await cli("release", action.id);
  assert.equal(storedAction(dbPath, action.id)?.status, "open");
  await cli("done", action.id);
  await assert.rejects(cli("snooze", action.id, "7"), { code: 1 });
  assert.equal(storedAction(dbPath, action.id)?.status, "closed");
  await assert.rejects(cli("reopen", action.id, "--read-only"), /read-only mode active/);
  assert.equal(storedAction(dbPath, action.id)?.status, "closed");
  await cli("reopen", action.id);
  assert.equal(storedAction(dbPath, action.id)?.status, "open");
  await assert.rejects(cli("reopen", action.id), { code: 1 });
  for (const command of ["claim", "release", "snooze", "done", "reopen"]) {
    const context =
      command === "claim"
        ? ["--harness", "claude", "--session", "missing-task-session", "--expect", "0".repeat(64)]
        : [];
    await assert.rejects(cli(command, "missing", ...context), { code: 1 });
    await assert.rejects(cli(command), { code: 2 });
  }
});
