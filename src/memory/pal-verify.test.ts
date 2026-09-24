import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it, type TestContext } from "node:test";
import { openMemoryDb } from "./db.js";
import {
  palAdd,
  palAutoVerify,
  palConfigure,
  palDone,
  palList,
  palReopen,
  palRelease,
  palSnooze,
  palResolve,
  palShow,
  palForget,
  importLegacyLedger,
} from "./pal.js";
import { mergeDb } from "./merge.js";

it("an imported revision invalidates a delayed verifier even when the display state is identical", async (t) => {
  const { db, id, request, path } = await fixture(t);
  const otherPath = join(dirname(path), "other.db");
  const other = openMemoryDb(otherPath);
  try {
    mergeDb(other, path);
    palSnooze(other, id, 1);
    palRelease(other, id);
    const verifying = palAutoVerify(db, 1);
    const response = await request();
    const before = palList(db, { readOnly: true });
    mergeDb(db, otherPath);
    assert.deepEqual(palList(db, { readOnly: true }), before);
    response.end();
    const result = await verifying;
    assert.deepEqual(result.closed, []);
    assert.deepEqual(result.stale, [id]);
  } finally {
    other.close();
  }
});

async function fixture(t: TestContext) {
  const previous = process.env.KIT_DEVICE_ID;
  process.env.KIT_DEVICE_ID = "pal-verify-fixture";
  const dir = mkdtempSync(join(tmpdir(), "kit-pal-verify-"));
  const path = join(dir, "memory.db");
  const db = openMemoryDb(path);
  const responses: ServerResponse[] = [];
  const waiting: ((response: ServerResponse) => void)[] = [];
  const request = () =>
    new Promise<ServerResponse>((resolve) => {
      const response = responses.shift();
      if (response) resolve(response);
      else waiting.push(resolve);
    });
  const calls: string[] = [];
  const server = createServer((incoming, response) => {
    calls.push(incoming.url ?? "");
    if (incoming.url !== "/") {
      response.end();
      return;
    }
    const receive = waiting.shift();
    if (receive) receive(response);
    else responses.push(response);
  });
  t.after(async () => {
    db.close();
    if (previous === undefined) delete process.env.KIT_DEVICE_ID;
    else process.env.KIT_DEVICE_ID = previous;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;
  const id = palAdd(db, {
    title: "handoff verification",
    check: { type: "http-status", url, expect: 200 },
  });
  return { db, id, request, path, url, calls };
}

it("an unavailable result from a revoked HTTP check is stale, not an active verification failure", async (t) => {
  const { db, id, request } = await fixture(t);
  const verifying = palAutoVerify(db, 1);
  const response = await request();
  assert.equal(palConfigure(db, id, null), true);
  const before = palList(db, { readOnly: true });
  response.destroy();
  const report = await verifying;
  assert.deepEqual(report.stale, [id]);
  assert.deepEqual(report.unverified, []);
  assert.equal(report.checked, 0);
  assert.deepEqual(palList(db, { readOnly: true }), before);
});

it("invalid stored HTTP expectations cannot reopen closed work or call the endpoint", async (t) => {
  const { db, id, url, calls } = await fixture(t);
  palDone(db, id);
  for (const expect of [99, 600, 200.5]) {
    const check = { type: "http-status", url: `${url}/must-not-call`, expect };
    db.prepare(
      "UPDATE pending_actions SET verify_definition = ?, verify_passes = 1 WHERE id = ?",
    ).run(JSON.stringify(check), id);
    const before = palList(db, { status: "closed", readOnly: true });
    const report = await palAutoVerify(db);
    assert.equal(report.checked, 0);
    assert.deepEqual(report.reopened, []);
    assert.deepEqual(
      report.unverified.map(({ id, reason }) => ({ id, reason })),
      [{ id, reason: "invalid-check" }],
    );
    assert.deepEqual(palList(db, { status: "closed", readOnly: true }), before);
    assert.deepEqual(calls, []);
  }
});

it("explicit manual configuration rejects an in-flight HTTP result and permits a new check", async (t) => {
  const { db, id, request, url } = await fixture(t);
  const verifying = palAutoVerify(db, 1);
  const response = await request();
  assert.equal(palConfigure(db, id, null), true);
  response.end();
  assert.deepEqual((await verifying).stale, [id]);
  assert.equal(palList(db, { readOnly: true })[0]?.kind, "manual");
  assert.equal((await palAutoVerify(db, 1)).checked, 0);
  assert.equal(palConfigure(db, id, { type: "http-status", url: `${url}/new`, expect: 200 }), true);
  assert.deepEqual((await palAutoVerify(db, 1)).closed, [id]);
});

it("a delayed passing check cannot close an action snoozed by the next agent", async (t) => {
  const { db, id, request } = await fixture(t);
  const verifying = palAutoVerify(db, 1);
  const response = await request();
  assert.equal(palSnooze(db, id, 1), true);
  const before = palList(db, { status: "snoozed", readOnly: true });
  response.end();
  const result = await verifying;
  assert.deepEqual(result.closed, []);
  assert.deepEqual(palList(db, { status: "snoozed", readOnly: true }), before);
});

it("a passing streak does not erase the action's next-check schedule", async (t) => {
  const { db, id, request } = await fixture(t);
  const view = palShow(db, id)!;
  palResolve(db, id, {
    expectedFrontier: view.frontier,
    choice: { state: { ...view.heads[0].state, next_check: "2030-01-01" } },
  });
  const verifying = palAutoVerify(db);
  (await request()).end();
  assert.deepEqual((await verifying).closed, []);
  const action = palList(db, { readOnly: true })[0]!;
  assert.equal(action.verify_passes, 1);
  assert.equal(action.next_check, "2030-01-01");
});

it("a delayed pass cannot close work that was closed and explicitly reopened", async (t) => {
  const { db, id, request } = await fixture(t);
  const verifying = palAutoVerify(db, 1);
  const response = await request();
  assert.equal(palDone(db, id), true);
  assert.equal(palReopen(db, id), true);
  const before = palList(db, { readOnly: true });
  response.end();
  assert.deepEqual((await verifying).closed, []);
  assert.deepEqual(palList(db, { readOnly: true }), before);
});

it("a delayed regression cannot reopen work the next agent explicitly closed again", async (t) => {
  const { db, id, request } = await fixture(t);
  palDone(db, id);
  const verifying = palAutoVerify(db);
  const response = await request();
  assert.equal(palReopen(db, id), true);
  assert.equal(palDone(db, id), true);
  const before = palList(db, { status: "closed", readOnly: true });
  response.statusCode = 503;
  response.end();
  assert.deepEqual((await verifying).reopened, []);
  assert.deepEqual(palList(db, { status: "closed", readOnly: true }), before);
});

it("competing verifiers cannot both report closing the same observed version", async (t) => {
  const { db, id, request } = await fixture(t);
  const first = palAutoVerify(db, 1);
  const response1 = await request();
  const second = palAutoVerify(db, 1);
  const response2 = await request();
  response1.end();
  assert.deepEqual((await first).closed, [id]);
  response2.end();
  assert.deepEqual((await second).closed, []);
});

it("a stale failure cannot erase a newer passing streak", async (t) => {
  const { db, request } = await fixture(t);
  const failing = palAutoVerify(db);
  const failure = await request();
  const passing = palAutoVerify(db);
  const success = await request();
  success.end();
  await passing;
  const before = palList(db, { readOnly: true });
  assert.equal(before[0]!.verify_passes, 1);
  failure.statusCode = 503;
  failure.end();
  await failing;
  assert.deepEqual(palList(db, { readOnly: true }), before);
});

it("legacy SQL through another connection cannot change an in-flight verifier's task", async (t) => {
  const { db, id, request, path } = await fixture(t);
  const verifying = palAutoVerify(db, 1);
  const response = await request();
  const other = new DatabaseSync(path);
  try {
    assert.throws(
      () => other.prepare("UPDATE pending_actions SET title = 'new intent' WHERE id = ?").run(id),
      /kit_pal_write|causal writer/i,
    );
  } finally {
    other.close();
  }
  response.end();
  assert.deepEqual((await verifying).closed, [id]);
  assert.equal(palShow(db, id)?.heads[0].state.title, "handoff verification");
});

it("a check result cannot be applied to a replacement with the same short ID", async (t) => {
  const { db, id, request, path } = await fixture(t);
  const verifying = palAutoVerify(db, 1);
  const response = await request();
  palForget(db, id, { expectedFrontier: palShow(db, id)!.frontier });
  const ledger = join(dirname(path), "replacement.jsonl");
  writeFileSync(ledger, JSON.stringify({ id, title: "replacement" }));
  assert.equal(importLegacyLedger(db, ledger).imported, 1);
  const before = palList(db, { readOnly: true });
  response.end();
  assert.deepEqual((await verifying).closed, []);
  assert.deepEqual(palList(db, { readOnly: true }), before);
});

it("a revoked verifier cannot finish from its old response", async (t) => {
  const { db, id, request } = await fixture(t);
  const verifying = palAutoVerify(db, 1);
  const response = await request();
  db.prepare(
    "UPDATE pending_actions SET verify_definition = NULL, kind = 'manual' WHERE id = ?",
  ).run(id);
  const before = palList(db, { readOnly: true });
  response.end();
  assert.deepEqual((await verifying).closed, []);
  assert.deepEqual(palList(db, { readOnly: true }), before);
});

it("a queued verifier revoked while an earlier check waits is never requested", async (t) => {
  const { db, id, request, url, calls } = await fixture(t);
  const queued = palAdd(db, {
    title: "queued check",
    check: { type: "http-status", url: `${url}/revoked`, expect: 200 },
  });
  const verifying = palAutoVerify(db, 1);
  const response = await request();
  db.prepare(
    "UPDATE pending_actions SET verify_definition = NULL, kind = 'manual' WHERE id = ?",
  ).run(queued);
  response.end();
  const result = await verifying;
  assert.deepEqual(calls, ["/"]);
  assert.deepEqual(result.closed, [id]);
  assert.deepEqual(result.stale, [queued]);
  assert.equal(result.checked, 1);
});

it("a newer passing closed-item check prevents an older failure from reopening it", async (t) => {
  const { db, id, request } = await fixture(t);
  palDone(db, id);
  const failing = palAutoVerify(db);
  const failure = await request();
  const passing = palAutoVerify(db);
  (await request()).end();
  assert.deepEqual((await passing).stale, []);
  failure.statusCode = 503;
  failure.end();
  const result = await failing;
  assert.deepEqual(result.reopened, []);
  assert.deepEqual(result.stale, [id]);
  assert.equal(palList(db, { status: "closed", readOnly: true })[0]?.id, id);
});

it("a passing closed-item check reports edits made while its request was running", async (t) => {
  const { db, id, request } = await fixture(t);
  palDone(db, id);
  const verifying = palAutoVerify(db);
  const response = await request();
  palReopen(db, id);
  response.end();
  assert.deepEqual((await verifying).stale, [id]);
  assert.equal(palList(db, { readOnly: true })[0]?.id, id);
});

it("replacing a whole action row from an older snapshot is refused before overwriting current work", async (t) => {
  const { db, id, request } = await fixture(t);
  db.exec("CREATE TEMP TABLE saved_action AS SELECT * FROM pending_actions");
  const verifying = palAutoVerify(db, 1);
  const response = await request();
  db.exec("UPDATE saved_action SET title = 'replacement work'");
  assert.throws(
    () => db.exec("INSERT OR REPLACE INTO pending_actions SELECT * FROM saved_action"),
    /causal writer/i,
  );
  response.end();
  const result = await verifying;
  assert.deepEqual(result.closed, [id]);
  assert.deepEqual(result.stale, []);
  assert.equal(palShow(db, id)?.heads[0].state.title, "handoff verification");
});

it("replaying a whole queued action row cannot restore permission for a revoked check", async (t) => {
  const { db, id, request, url, calls } = await fixture(t);
  const queued = palAdd(db, {
    title: "queued snapshot",
    check: { type: "http-status", url: `${url}/revoked`, expect: 200 },
  });
  db.prepare("CREATE TEMP TABLE saved_action AS SELECT * FROM pending_actions WHERE id = ?").run(
    queued,
  );
  const columns = db
    .prepare("PRAGMA table_info(pending_actions)")
    .all()
    .map((row) => row.name)
    .join(", ");
  const verifying = palAutoVerify(db, 1);
  const response = await request();
  assert.throws(
    () =>
      db
        .prepare("UPDATE pending_actions SET title = 'intervening change' WHERE id = ?")
        .run(queued),
    /causal writer/i,
  );
  palConfigure(db, queued, null);
  db.exec("UPDATE saved_action SET kind = 'manual', verify_definition = NULL");
  assert.throws(
    () =>
      db
        .prepare(
          `UPDATE pending_actions SET (${columns}) = (SELECT ${columns} FROM saved_action) WHERE id = ?`,
        )
        .run(queued),
    /causal writer/i,
  );
  response.end();
  const result = await verifying;
  assert.deepEqual(calls, ["/"]);
  assert.deepEqual(result.closed, [id]);
  assert.deepEqual(result.stale, [queued]);
});
