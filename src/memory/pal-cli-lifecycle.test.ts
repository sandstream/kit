import { it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openMemoryDb } from "./db.js";
import type { PendingAction } from "./pal.js";
import type { PalView } from "./pal-revisions.js";
import { fixture, storedAction } from "./pal-cli.test-support.js";
import { seedLegacyPalDb, withPalDevice } from "./pal-fixture.test-support.js";

it("competing CLI claims from the same inspected frontier retain exactly one session owner", async (t) => {
  const { cli, dbPath } = await fixture(t);
  await cli("add", "Claim once");
  const [action] = JSON.parse(await cli("list", "--json")) as PendingAction[];
  const inspected: PalView = JSON.parse(await cli("show", action.id, "--json"));
  const owners = ["claude", "codex"];
  const results = await Promise.allSettled(
    owners.map((owner) =>
      cli(
        "claim",
        action.id,
        "--harness",
        owner,
        "--session",
        `${owner}-session`,
        "--expect",
        inspected.frontier,
        "--json",
      ),
    ),
  );
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const winner = results.findIndex((result) => result.status === "fulfilled");
  for (const result of results) {
    if (result.status === "fulfilled") assert.equal(JSON.parse(result.value).status, "applied");
    else {
      assert.equal(result.reason.code, 1);
      assert.equal(JSON.parse(result.reason.stdout).status, "stale");
    }
  }
  assert.equal(storedAction(dbPath, action.id)?.claimed_by, owners[winner]);
  assert.equal(storedAction(dbPath, action.id)?.status, "claimed");
  const retained: PalView = JSON.parse(await cli("show", action.id, "--json"));
  assert.deepEqual(retained.heads[0].state.claim_owner, {
    device: "pal-cli-device",
    harness: owners[winner],
    session: `${owners[winner]}-session`,
  });
  const won = results[winner];
  assert.equal(won.status, "fulfilled");
  assert.equal(retained.frontier, JSON.parse(won.value).view.frontier);
});

it("PAL optional arguments remain positional when leading or trailing global flags are present", async (t) => {
  const { cli, invoke, dbPath } = await fixture(t);
  await cli("add", "Default arguments");
  const [action] = JSON.parse(await cli("list", "--json")) as PendingAction[];
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const days = () =>
      db
        .prepare(
          "SELECT round(julianday(snooze_until)-julianday('now')) AS days FROM pending_actions WHERE id=?",
        )
        .get(action.id)?.days;
    await cli("snooze", action.id, "--non-interactive");
    assert.equal(days(), 7);
    await invoke(["snooze", action.id], ["--non-interactive"]);
    assert.equal(days(), 7);
    await cli("snooze", action.id, "--non-interactive", "2");
    assert.equal(days(), 2);
    await cli("snooze", action.id, "--env=dev");
    assert.equal(days(), 7);
    await cli("release", action.id);
    const inspected: PalView = JSON.parse(await cli("show", action.id, "--json"));
    await cli(
      "claim",
      action.id,
      "--non-interactive",
      "--harness",
      "claude",
      "--session",
      "default-label",
      "--expect",
      inspected.frontier,
    );
    assert.equal(
      storedAction(dbPath, action.id)?.claimed_by,
      "claude",
      "default label is the declared harness, not device identity",
    );
  } finally {
    db.close();
  }
});

it("PAL CLI read-only listing cannot create a missing device identity", async (t) => {
  const { cli, dbPath } = await fixture(t, "");
  seedLegacyPalDb(dbPath, [{ id: "legacy", title: "Legacy local work" }]);
  withPalDevice("pal-cli-device", () => openMemoryDb(dbPath).close());
  const path = join(dirname(dbPath), "device-id");
  assert.equal(existsSync(path), false);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const before = db.prepare("SELECT * FROM pending_actions").all();
    const expected = before.map((row) => {
      const visible = { ...row };
      delete visible.verify_definition;
      return visible;
    });
    assert.deepEqual(JSON.parse(await cli("list", "--json", "--read-only")), expected);
    assert.deepEqual(db.prepare("SELECT * FROM pending_actions").all(), before);
    assert.equal(existsSync(path), false);
  } finally {
    db.close();
  }
});

it("PAL CLI preserves old claims across read-only inspection and requires takeover after migration", async (t) => {
  const { cli, dbPath } = await fixture(t);
  const action = { id: "legacy-claimed", title: "Read-only snapshot" };
  seedLegacyPalDb(dbPath, [
    {
      ...action,
      status: "claimed",
      origin_device: "pal-cli-device",
      claimed_by: "reviewer",
      claimed_at: "2000-01-01 00:00:00",
    },
  ]);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const before = storedAction(dbPath, action.id);
    assert.deepEqual(JSON.parse(await cli("list", "--read-only", "--json")), []);
    const [readOnlyClaim] = JSON.parse(
      await cli("list", "--read-only", "--json", "--status=claimed"),
    );
    assert.equal(readOnlyClaim.id, action.id);
    assert.equal(readOnlyClaim.claimed_by, "reviewer");
    assert.deepEqual(storedAction(dbPath, action.id), before);
    assert.equal(db.prepare("SELECT version FROM schema_meta").get()?.version, 10);
    assert.deepEqual(JSON.parse(await cli("list", "--json")), []);
    const [migratedClaim] = JSON.parse(await cli("list", "--json", "--status=claimed"));
    assert.equal(migratedClaim.id, action.id);
    assert.equal(migratedClaim.claimed_by, "reviewer");
    assert.equal(migratedClaim.claimed_at, "2000-01-01 00:00:00");
    assert.equal(migratedClaim.claim_owner, null);
    const inspected: PalView = JSON.parse(await cli("show", action.id, "--json"));
    const ownership = ["--harness", "codex", "--session", "takeover-session"];
    await assert.rejects(
      cli("release", action.id, ...ownership, "--expect", inspected.frontier, "--json"),
      (error: unknown) => {
        const failure = error as { code?: number; stdout?: string };
        assert.equal(failure.code, 1);
        assert.equal(JSON.parse(failure.stdout ?? "").status, "legacy-owner");
        return true;
      },
    );
    assert.equal(storedAction(dbPath, action.id)?.status, "claimed");
    const takeover = JSON.parse(
      await cli("takeover", action.id, ...ownership, "--expect", inspected.frontier, "--json"),
    );
    assert.equal(takeover.status, "applied");
    assert.deepEqual(takeover.view.heads[0].state.claim_owner, {
      device: "pal-cli-device",
      harness: "codex",
      session: "takeover-session",
    });
    await cli("release", action.id, ...ownership, "--expect", takeover.view.frontier);
    assert.equal(storedAction(dbPath, action.id)?.status, "open");
  } finally {
    db.close();
  }
});

it("PAL CLI read-only inspection supports the older column layout without backfilling", async (t) => {
  const { cli, dbPath } = await fixture(t);
  mkdirSync(dirname(dbPath));
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE schema_meta (version INTEGER NOT NULL);
      INSERT INTO schema_meta VALUES (6);
      CREATE TABLE pending_actions (
        id TEXT PRIMARY KEY, status TEXT, title TEXT, scope TEXT, kind TEXT,
        origin_device TEXT, claimed_by TEXT, claimed_at TEXT, created_at TEXT
      );
      INSERT INTO pending_actions VALUES (
        'legacy', 'claimed', 'Older claimed work', NULL, 'manual',
        'pal-cli-device', 'older-agent', '2000-01-01 00:00:00', '2000-01-01 00:00:00'
      );
    `);
    const schema = db.prepare("SELECT sql FROM sqlite_master ORDER BY name").all();
    assert.deepEqual(JSON.parse(await cli("list", "--json", "--read-only")), []);
    const [action] = JSON.parse(await cli("list", "--json", "--read-only", "--status=claimed"));
    assert.equal(action.id, "legacy");
    assert.equal(action.claimed_by, "older-agent");
    assert.equal(db.prepare("SELECT version FROM schema_meta").get()?.version, 6);
    assert.deepEqual(db.prepare("SELECT sql FROM sqlite_master ORDER BY name").all(), schema);
  } finally {
    db.close();
  }
});
