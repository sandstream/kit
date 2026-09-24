import assert from "node:assert/strict";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { it, type TestContext } from "node:test";
import { openMemoryDb } from "./db.js";
import { palAdd, palAutoVerify, palConfigure, palList } from "./pal.js";
import { palAutoVerify as legacyVerify } from "./pal-legacy.test-support.js";
import { fixture as filesFixture, modes } from "./backup.test-support.js";

async function fixture(t: TestContext) {
  const files = filesFixture(t);
  const previous = process.env.KIT_DEVICE_ID;
  process.env.KIT_DEVICE_ID = "compatibility-device";
  t.after(() => {
    if (previous === undefined) delete process.env.KIT_DEVICE_ID;
    else process.env.KIT_DEVICE_ID = previous;
  });
  const calls: string[] = [];
  const server = createServer((request, response) => {
    calls.push(request.url ?? "");
    response.end();
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const check = {
    type: "http-status" as const,
    url: `http://127.0.0.1:${address.port}/check`,
    expect: 200,
  };
  return { ...files, calls, check };
}

it("frozen legacy verifier really executes an old-format HTTP check", async (t) => {
  const { calls, check, track } = await fixture(t);
  const db = track(new DatabaseSync(":memory:"));
  db.exec(`CREATE TABLE pending_actions (
    id TEXT PRIMARY KEY, status TEXT, kind TEXT, verify_check TEXT,
    verify_passes INTEGER DEFAULT 0, closed_at TEXT
  )`);
  db.prepare(
    "INSERT INTO pending_actions(id,status,kind,verify_check) VALUES ('old','open','auto',?)",
  ).run(JSON.stringify(check));
  assert.deepEqual((await legacyVerify(db, 1)).closed, ["old"]);
  assert.deepEqual(calls, ["/check"]);
});

for (const mode of modes) {
  it(`${mode.name} restored checks stay inert for legacy clients before and after local approval`, async (t) => {
    const { src, blob, dest, track, calls, check } = await fixture(t);
    const source = track(openMemoryDb(src));
    const id = palAdd(source, { title: "portable history, local permission", check });
    mode.backup(src, blob);
    mode.restore(blob, dest);
    const restored = track(new DatabaseSync(dest));
    const before = palList(restored, { readOnly: true });
    assert.equal((await legacyVerify(restored, 1)).checked, 0);
    assert.deepEqual(calls, [], "the old client must not make the restored request");
    assert.deepEqual(palList(restored, { readOnly: true }), before);
    assert.equal((await palAutoVerify(restored, 1)).unverified[0]?.reason, "no-local-approval");
    assert.equal(
      before[0]?.verify_check,
      JSON.stringify(check),
      "public inspection retains the definition",
    );

    assert.equal(palConfigure(restored, id, check), true);
    assert.equal((await legacyVerify(restored, 1)).checked, 0);
    assert.deepEqual((await palAutoVerify(restored, 1)).closed, [id]);
    assert.deepEqual((await palAutoVerify(source, 1)).closed, [id]);
    assert.deepEqual(calls, ["/check", "/check"]);
  });
}

it("legacy SQL cannot insert or reactivate executable checks in a current store", async (t) => {
  const { track, src, check, calls } = await fixture(t);
  const db = track(openMemoryDb(src));
  const id = palAdd(db, { title: "manual task" });
  const before = palList(db, { readOnly: true });
  for (const sql of [
    "INSERT INTO pending_actions(id,title,kind,verify_check) VALUES ('legacy','legacy task','auto',?)",
    "UPDATE pending_actions SET kind='auto', verify_check=?",
    "INSERT OR REPLACE INTO pending_actions(id,title,kind,verify_check) SELECT id,title,'auto',? FROM pending_actions",
  ]) {
    assert.throws(
      () => db.prepare(sql).run(JSON.stringify(check)),
      /legacy verification.*update kit|causal writer/i,
    );
    assert.deepEqual(palList(db, { readOnly: true }), before);
  }
  assert.equal((await legacyVerify(db, 1)).checked, 0);
  assert.deepEqual(calls, []);
  assert.throws(
    () =>
      db.prepare("UPDATE pending_actions SET title='edited by an older client' WHERE id=?").run(id),
    /causal writer/i,
  );
  assert.deepEqual(palList(db, { readOnly: true }), before);
  assert.equal(palConfigure(db, id, check), true);
  assert.deepEqual((await palAutoVerify(db, 1)).closed, [id]);
});
