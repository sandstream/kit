import { it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { createServer, type ServerResponse } from "node:http";
import { openMemoryDb } from "./db.js";
import { palAdd, type PendingAction } from "./pal.js";
import type { PalView } from "./pal-revisions.js";
import { fixture } from "./pal-cli.test-support.js";
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
