import { it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { createServer, type ServerResponse } from "node:http";
import { openMemoryDb } from "./db.js";
import { palAdd, type PendingAction } from "./pal.js";
import type { PalView } from "./pal-revisions.js";
import { fixture, storedAction } from "./pal-cli.test-support.js";
import { claimTask, seedLegacyPalDb, withPalDevice } from "./pal-fixture.test-support.js";

const exec = promisify(execFile);

it("PAL CLI JSON verification uses the creation project across separate CLI processes", async (t) => {
  const { cli, invoke, root } = await fixture(t);
  const other = join(root, "other-project");
  mkdirSync(other);
  await exec("git", ["init", "-q", other]);
  writeFileSync(join(other, "artifact"), "wrong project's file");
  await cli("add", "creation project artifact", "--verify-file", "artifact");
  const [action] = JSON.parse(await cli("list", "--json")) as PendingAction[];
  const first = JSON.parse(await invoke(["verify", "--json"], [], other));
  assert.equal(first.checked, 1);
  assert.deepEqual(first.closed, []);
  assert.deepEqual(first.unverified, []);
  writeFileSync(join(root, "artifact"), "creation project's file");
  await invoke(["verify", "--json"], [], other);
  const confirmed = JSON.parse(await invoke(["verify", "--json"], [], other));
  assert.deepEqual(confirmed.closed, [action.id]);
});

it("PAL CLI exits nonzero and explains an unbound check in JSON and text", async (t) => {
  const { cli, dbPath } = await fixture(t);
  const action = { id: "legacy", title: "legacy check" };
  seedLegacyPalDb(dbPath, [
    {
      ...action,
      kind: "auto",
      verify_check: JSON.stringify({ type: "file-exists", path: "artifact" }),
    },
  ]);
  for (const format of [[], ["--json"]]) {
    await assert.rejects(cli("verify", ...format), (error: unknown) => {
      const failure = error as { code?: number; stdout?: string };
      assert.equal(failure.code, 1);
      const output = failure.stdout ?? "";
      if (format.length) {
        const report = JSON.parse(output);
        assert.equal(report.checked, 0);
        assert.deepEqual(
          report.unverified.map((item: { id: string; reason: string }) => ({
            id: item.id,
            reason: item.reason,
          })),
          [{ id: action.id, reason: "unbound-path" }],
        );
      } else {
        assert.match(output, /unverified 1/);
        assert.match(output, /Relative file check has no creation directory/);
      }
      return true;
    });
  }
  assert.equal((JSON.parse(await cli("list", "--json")) as PendingAction[])[0]?.id, action.id);
});

it("PAL CLI reports a stale verifier result instead of claiming it closed newer work", async (t) => {
  const { cli } = await fixture(t);
  let received!: (response: ServerResponse) => void;
  const request = new Promise<ServerResponse>((resolve) => {
    received = resolve;
  });
  const server = createServer((_request, response) => received(response));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await cli("add", "check while handing off", "--verify-http", `http://127.0.0.1:${address.port}`);
  const [action] = JSON.parse(await cli("list", "--json")) as PendingAction[];
  const verifying = cli("verify");
  const response = await Promise.race([
    request,
    verifying.then(() => {
      throw new Error("verify finished before checking the endpoint");
    }),
  ]);
  await cli("snooze", action.id, "1");
  response.end();
  const report = await verifying;
  assert.match(report, /closed 0/);
  assert.match(report, /stale 1/);
  const snoozed = JSON.parse(await cli("list", "--status=snoozed", "--json")) as PendingAction[];
  assert.equal(snoozed[0]?.id, action.id);
  assert.equal(snoozed[0]?.verify_passes, 0);
});

it("PAL CLI lists claimed, snoozed and closed work without changing the open default", async (t) => {
  const { cli, dbPath } = await fixture(t);
  const list = async (...args: string[]): Promise<PendingAction[]> =>
    JSON.parse(await cli("list", "--json", ...args));
  await cli("add", "Handoff task");
  const [action] = await list();
  assert.equal(action.status, "open");
  const ownership = ["--harness", "claude", "--session", "review-session"];
  const inspected: PalView = JSON.parse(await cli("show", action.id, "--json"));
  const claim = JSON.parse(
    await cli(
      "claim",
      action.id,
      "reviewer",
      ...ownership,
      "--expect",
      inspected.frontier,
      "--json",
    ),
  );
  assert.equal(claim.status, "applied");
  assert.deepEqual(await list(), []);
  const [claimed] = await list("--status=claimed");
  assert.equal(claimed?.id, action.id);
  assert.equal(claimed?.claimed_by, "reviewer");
  assert.deepEqual(claimed?.claim_owner, {
    device: "pal-cli-device",
    harness: "claude",
    session: "review-session",
  });
  assert.match(await cli("list", "--status", "claimed"), /1.* claimed action item/);
  assert.match(await cli("list", "--status=claimed"), /claimed by reviewer/);
  const db = openMemoryDb(dbPath);
  try {
    withPalDevice("pal-cli-device", () => {
      const id = palAdd(db, { title: "Other project", scope: "/unrelated-project" });
      claimTask(db, id, "reviewer");
    });
    withPalDevice("foreign-device", () => {
      const id = palAdd(db, { title: "Other device" });
      claimTask(db, id, "foreign-reviewer");
    });
  } finally {
    db.close();
  }
  assert.deepEqual(
    (await list("--status=claimed")).map((item) => item.id),
    [action.id],
  );
  assert.equal((await list("--status=claimed", "--all")).length, 2);
  assert.equal((await list("--status=claimed", "--global")).length, 2);
  assert.equal((await list("--status=claimed", "--all", "--global")).length, 3);
  await cli("release", action.id, ...ownership, "--expect", claim.view.frontier);
  assert.equal((await list())[0]?.id, action.id);
  await cli("snooze", action.id, "1");
  assert.equal((await list("--status=snoozed"))[0]?.id, action.id);
  assert.deepEqual(await list(), []);
  await cli("done", action.id);
  assert.equal((await list("--status=closed"))[0]?.id, action.id);
  assert.deepEqual(await list("--status=snoozed"), []);
  assert.match(await cli("list", "--status=snoozed"), /no snoozed action items/);
});

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
