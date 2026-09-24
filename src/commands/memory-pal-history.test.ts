import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { it } from "node:test";
import { join } from "node:path";
import { fixture } from "../memory/pal-cli.test-support.js";
import { openMemoryDb } from "../memory/db.js";
import { mergeDb } from "../memory/merge.js";
import { palDone } from "../memory/pal.js";
import type { PalView } from "../memory/pal-revisions.js";

const OWNER = ["--harness", "claude-code", "--session", "owner-session"];
const OTHER = ["--harness", "codex", "--session", "other-session"];

async function rejectedJson(command: Promise<string>, code: number) {
  let output: unknown;
  await assert.rejects(command, (error: unknown) => {
    assert.ok(error instanceof Error && "code" in error && "stdout" in error);
    assert.equal(error.code, code);
    assert.equal(typeof error.stdout, "string");
    output = JSON.parse(String(error.stdout));
    return true;
  });
  return output;
}

it("PAL show reports a missing item as JSON without creating a private database", async (t) => {
  const { cli, dbPath } = await fixture(t);
  assert.deepEqual(await rejectedJson(cli("show", "missing", "--json"), 1), {
    id: "missing",
    status: "missing",
  });
  assert.equal(existsSync(dbPath), false);
  assert.deepEqual(JSON.parse(await cli("list", "--conflicts", "--json")), []);
  assert.equal(existsSync(dbPath), false);
});

it("history argument errors emit one JSON diagnostic before opening memory", async (t) => {
  const { cli, dbPath } = await fixture(t);
  for (const args of [
    ["resolve", "missing"],
    ["forget", "missing"],
    ["show", "missing", "--history", "--history"],
    ["show", "missing", "--status", "open"],
  ]) {
    const result = (await rejectedJson(cli(...args, "--json"), 2)) as {
      ok: boolean;
      error: string;
    };
    assert.equal(result.ok, false);
    assert.match(result.error, /usage: kit memory pal/);
    assert.equal(existsSync(dbPath), false);
  }
});

it("resolve and forget preserve ownership and require the same session receipt", async (t) => {
  const { cli, root } = await fixture(t, "history-device");
  await cli("add", "Resolve only owned state");
  const [{ id }] = JSON.parse(await cli("list", "--json"));
  const open: PalView = JSON.parse(await cli("show", id, "--json"));
  const { view: claimed }: { view: PalView } = JSON.parse(
    await cli("claim", id, ...OWNER, "--expect", open.frontier, "--json"),
  );
  for (const [context, status] of [
    [[], "owner-required"],
    [OTHER, "not-owner"],
  ] as const) {
    for (const [action, choice] of [
      ["resolve", ["--take", claimed.heads[0].id]],
      ["forget", []],
    ] as const) {
      const result = (await rejectedJson(
        cli(action, id, ...context, "--expect", claimed.frontier, ...choice, "--json"),
        1,
      )) as { status: string };
      assert.equal(result.status, status);
      assert.deepEqual(JSON.parse(await cli("show", id, "--json")), claimed);
    }
  }
  const unchanged = (await rejectedJson(
    cli(
      "resolve",
      id,
      ...OWNER,
      "--expect",
      claimed.frontier,
      "--take",
      claimed.heads[0].id,
      "--json",
    ),
    1,
  )) as { status: string };
  assert.equal(unchanged.status, "unchanged");
  const statePath = join(root, "resolution.json");
  writeFileSync(
    statePath,
    JSON.stringify({ ...claimed.heads[0].state, detail: "Same-session review complete" }),
  );
  const resolved = JSON.parse(
    await cli(
      "resolve",
      id,
      ...OWNER,
      "--expect",
      claimed.frontier,
      "--state",
      statePath,
      "--json",
    ),
  );
  assert.equal(resolved.status, "applied");
  assert.notEqual(resolved.view.frontier, claimed.frontier);
  assert.deepEqual(resolved.view.heads[0].state.claim_owner, claimed.heads[0].state.claim_owner);
  assert.equal(resolved.view.heads[0].state.detail, "Same-session review complete");
  const stale = (await rejectedJson(
    cli("forget", id, ...OWNER, "--expect", claimed.frontier, "--json"),
    1,
  )) as { status: string };
  assert.equal(stale.status, "stale");
  assert.deepEqual(JSON.parse(await cli("show", id, "--json")), resolved.view);
  const forgotten = JSON.parse(
    await cli("forget", id, ...OWNER, "--expect", resolved.view.frontier, "--json"),
  );
  assert.equal(forgotten.status, "applied");
  assert.equal(forgotten.ok, true);
  assert.deepEqual(await rejectedJson(cli("show", id, "--history", "--json"), 1), {
    id,
    status: "missing",
  });
});

it("custom resolution cannot mint or transfer session ownership", async (t) => {
  const { cli, root } = await fixture(t, "history-device");
  await cli("add", "No resolution shortcut");
  const [{ id }] = JSON.parse(await cli("list", "--json"));
  const open: PalView = JSON.parse(await cli("show", id, "--json"));
  const path = join(root, "forged-owner.json");
  writeFileSync(
    path,
    JSON.stringify({
      ...open.heads[0].state,
      status: "claimed",
      claimed_by: "other",
      claimed_at: "2030-01-01 00:00:00",
      claim_owner: { device: "history-device", harness: "codex", session: "other-session" },
    }),
  );
  const minted = (await rejectedJson(
    cli("resolve", id, ...OTHER, "--expect", open.frontier, "--state", path, "--json"),
    1,
  )) as { status: string };
  assert.equal(minted.status, "owner-required");
  assert.deepEqual(JSON.parse(await cli("show", id, "--json")), open);
  const claimed = JSON.parse(await cli("claim", id, ...OWNER, "--expect", open.frontier, "--json"));
  writeFileSync(
    path,
    JSON.stringify({
      ...claimed.view.heads[0].state,
      claim_owner: { device: "history-device", harness: "codex", session: "other-session" },
    }),
  );
  const transferred = (await rejectedJson(
    cli("resolve", id, ...OWNER, "--expect", claimed.view.frontier, "--state", path, "--json"),
    1,
  )) as { status: string };
  assert.equal(transferred.status, "owner-required");
  assert.deepEqual(JSON.parse(await cli("show", id, "--json")), claimed.view);
});

it("history commands reject unpaired or repeated identity flags without creating memory", async (t) => {
  const { cli, dbPath } = await fixture(t);
  for (const [action, choice] of [
    ["resolve", ["--take", "a".repeat(32)]],
    ["forget", []],
  ] as const) {
    for (const context of [
      ["--session", "unpaired"],
      ["--harness", "unpaired"],
      [...OWNER, "--session", "repeated"],
      ["--harness", "claude-code", "--session="],
    ]) {
      const result = (await rejectedJson(
        cli(action, "missing", ...choice, ...context, "--expect", "0".repeat(64), "--json"),
        2,
      )) as { ok: boolean };
      assert.equal(result.ok, false);
      assert.equal(existsSync(dbPath), false);
    }
  }
});

it("CLI forget requires a current frontier and read-only mode refuses erasure", async (t) => {
  const { cli } = await fixture(t);
  await cli("add", "Forget this task");
  const [{ id }] = JSON.parse(await cli("list", "--json"));
  const view: PalView = JSON.parse(await cli("show", id, "--json"));
  await assert.rejects(
    cli("forget", id, "--expect", view.frontier, "--read-only"),
    /read-only mode active/,
  );
  assert.deepEqual(JSON.parse(await cli("show", id, "--json")), view);
  await assert.rejects(cli("forget", id, "--json"), { code: 2 });
  const result = JSON.parse(await cli("forget", id, "--expect", view.frontier, "--json"));
  assert.equal(result.status, "applied");
  assert.equal(result.ok, true);
  assert.deepEqual(await rejectedJson(cli("show", id, "--history", "--json"), 1), {
    id,
    status: "missing",
  });
});

it("CLI exposes both alternatives, resolves an exact frontier and rejects stale follow-up writes", async (t) => {
  const { cli, dbPath, root } = await fixture(t);
  await cli("add", "Inspect receipt");
  const [{ id }] = JSON.parse(await cli("list", "--json"));
  const before: PalView = JSON.parse(await cli("show", id, "--json"));
  const otherPath = join(root, "other.db");
  const other = openMemoryDb(otherPath);
  try {
    mergeDb(other, dbPath);
    palDone(other, id);
  } finally {
    other.close();
  }
  await cli("snooze", id, "3", "--expect", before.frontier, "--json");
  const local = openMemoryDb(dbPath);
  try {
    mergeDb(local, otherPath);
  } finally {
    local.close();
  }
  const conflict: PalView = JSON.parse(await cli("show", id, "--history", "--json"));
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.heads.length, 2);
  assert.equal(conflict.history?.length, 3);
  assert.deepEqual(
    JSON.parse(await cli("list", "--conflicts", "--json")).map((row: { id: string }) => row.id),
    [id],
  );
  const take = conflict.heads.find(({ state }) => state.status === "closed")!.id;
  const resolved = JSON.parse(
    await cli("resolve", id, "--expect", conflict.frontier, "--take", take, "--json"),
  );
  assert.equal(resolved.status, "applied");
  assert.equal(resolved.view.conflict, false);
  assert.deepEqual(JSON.parse(await cli("list", "--conflicts", "--json")), []);
  assert.equal(
    (
      (await rejectedJson(
        cli("resolve", id, "--expect", conflict.frontier, "--take", take, "--json"),
        1,
      )) as { status: string }
    ).status,
    "stale",
  );
  assert.equal(
    (
      (await rejectedJson(cli("reopen", id, "--expect", conflict.frontier, "--json"), 1)) as {
        status: string;
      }
    ).status,
    "stale",
  );
  assert.deepEqual(JSON.parse(await cli("show", id, "--json")), resolved.view);
});
