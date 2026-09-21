import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { it, type TestContext } from "node:test";
import { fixture } from "../memory/pal-cli.test-support.js";
import type { PalView } from "../memory/pal-revisions.js";
import { openMemoryDb } from "../memory/db.js";
import { mergeDb } from "../memory/merge.js";
import { seedLegacyPalDb } from "../memory/pal-fixture.test-support.js";

const CLAUDE = ["--harness", "claude-code", "--session", "claude-session"];
const CODEX = ["--harness", "codex", "--session", "codex-session"];
const FRONTIER = "0".repeat(64);

async function rejectedJson(command: Promise<string>, code = 1) {
  let result: { status?: string; error?: string; ok?: boolean; view?: PalView } | undefined;
  await assert.rejects(command, (error: unknown) => {
    assert.ok(error instanceof Error && "code" in error && "stdout" in error);
    assert.equal(error.code, code);
    assert.equal(typeof error.stdout, "string");
    result = JSON.parse(String(error.stdout));
    return true;
  });
  assert.ok(result);
  return result;
}

it("CLI claim requires explicit session context before creating memory", async (t) => {
  const { cli, dbPath } = await fixture(t, "claims-device", {
    CLAUDE_SESSION_ID: "not-authoritative",
    CODEX_THREAD_ID: "not-authoritative",
  });
  const result = await rejectedJson(cli("claim", "missing", "--json"), 2);
  assert.equal(result.ok, false);
  assert.match(result.error!, /--harness.*--session.*--expect/);
  assert.equal(existsSync(dbPath), false);
});

it("CLI renewal rotates the receipt and never retries a stale claim operation", async (t) => {
  const { cli } = await fixture(t, "claims-device");
  await cli("add", "Keep receipt review owned");
  const [{ id }] = JSON.parse(await cli("list", "--json"));
  const before: PalView = JSON.parse(await cli("show", id, "--json"));
  const claimed = JSON.parse(
    await cli("claim", id, ...CLAUDE, "--expect", before.frontier, "--json"),
  );
  const renewed = JSON.parse(
    await cli("renew", id, ...CLAUDE, "--expect", claimed.view.frontier, "--json"),
  );
  assert.equal(renewed.status, "applied");
  assert.notEqual(renewed.view.frontier, claimed.view.frontier);
  assert.deepEqual(
    renewed.view.heads[0].state.claim_owner,
    claimed.view.heads[0].state.claim_owner,
  );
  for (const action of ["renew", "takeover", "claim"]) {
    const stale = await rejectedJson(
      cli(action, id, ...CLAUDE, "--expect", claimed.view.frontier, "--json"),
    );
    assert.equal(stale.status, "stale");
    assert.deepEqual(stale.view, renewed.view);
  }
  assert.equal(
    (await rejectedJson(cli("release", id, ...CLAUDE, "--expect", claimed.view.frontier, "--json")))
      .status,
    "stale",
  );
  assert.deepEqual(JSON.parse(await cli("show", id, "--json")), renewed.view);
  assert.equal(
    JSON.parse(await cli("release", id, ...CLAUDE, "--expect", renewed.view.frontier, "--json"))
      .status,
    "applied",
  );
  const released: PalView = JSON.parse(await cli("show", id, "--json"));
  assert.equal(released.heads[0].state.status, "open");
  assert.equal(released.heads[0].state.claim_owner, null);
});

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
