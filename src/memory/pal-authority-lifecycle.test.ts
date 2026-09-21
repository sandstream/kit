import assert from "node:assert/strict";
import crypto from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { openMemoryDb } from "./db.js";
import { palAdd, palAutoVerify, palConfigure, palList, palResolve, palShow } from "./pal.js";
import { fixture as filesFixture, restoreMocks } from "./backup.test-support.js";

function fixture(t: TestContext) {
  const files = filesFixture(t);
  const previousDir = process.env.KIT_MEMORY_DIR;
  const previousDevice = process.env.KIT_DEVICE_ID;
  process.env.KIT_MEMORY_DIR = files.dir;
  process.env.KIT_DEVICE_ID = "authority-lifecycle-fixture";
  t.after(() => {
    restoreMocks(t);
    if (previousDir === undefined) delete process.env.KIT_MEMORY_DIR;
    else process.env.KIT_MEMORY_DIR = previousDir;
    if (previousDevice === undefined) delete process.env.KIT_DEVICE_ID;
    else process.env.KIT_DEVICE_ID = previousDevice;
  });
  return { ...files, db: files.track(openMemoryDb(files.src)) };
}

it("configuring a neighboring restored store preserves the source approval", async (t) => {
  const { db, src, dest, track } = fixture(t);
  const check = { type: "file-exists" as const, path: src };
  const id = palAdd(db, { title: "source artifact", check });
  db.prepare("VACUUM main INTO ?").run(dest);
  const restored = track(openMemoryDb(dest));
  assert.equal((await palAutoVerify(restored, 1)).unverified[0]?.reason, "no-local-approval");

  assert.equal(palConfigure(restored, id, check), true);
  assert.deepEqual((await palAutoVerify(restored, 1)).closed, [id]);
  assert.deepEqual((await palAutoVerify(db, 1)).closed, [id]);
});

it("different devices can approve the same token without replacing each other's marker", async (t) => {
  const { db, src } = fixture(t);
  t.mock.method(crypto, "randomBytes", (size: number) => Buffer.alloc(size, 0x17));
  syncBuiltinESMExports();
  const check = { type: "file-exists" as const, path: src };
  const id = palAdd(db, { title: "device-local approval", check });
  process.env.KIT_DEVICE_ID = "other-device";
  assert.equal(palConfigure(db, id, check), true);
  restoreMocks(t);
  assert.equal((await palAutoVerify(db)).checked, 1);
  process.env.KIT_DEVICE_ID = "authority-lifecycle-fixture";
  assert.deepEqual((await palAutoVerify(db)).closed, [id]);
});

for (const mode of ["manual", "replacement"]) {
  it(`nested ${mode} configuration is rejected without changing caller state or approvals`, async (t) => {
    const { db, dir, src } = fixture(t);
    const check = { type: "file-exists" as const, path: src };
    const id = palAdd(db, { title: "approved artifact", check });
    const directory = join(dir, ".kit-verifier-grants");
    const markers = readdirSync(directory);
    delete process.env.KIT_DEVICE_ID;
    db.exec("BEGIN");
    try {
      const view = palShow(db, id)!;
      palResolve(db, id, {
        expectedFrontier: view.frontier,
        choice: { state: { ...view.heads[0].state, title: "caller edit" } },
      });
      const before = palList(db, { allDevices: true, readOnly: true });
      assert.throws(() => palConfigure(db, id, mode === "manual" ? null : check), /transaction/);
      assert.deepEqual(palList(db, { allDevices: true, readOnly: true }), before);
      assert.deepEqual(readdirSync(directory), markers);
      assert.equal(existsSync(join(dir, "device-id")), false);
    } finally {
      db.exec("ROLLBACK");
    }
    process.env.KIT_DEVICE_ID = "authority-lifecycle-fixture";
    assert.equal(palList(db, { readOnly: true })[0]?.title, "approved artifact");
    assert.deepEqual((await palAutoVerify(db, 1)).closed, [id]);
  });
}

for (const mode of ["ABORT", "ROLLBACK"]) {
  it(`SQL ${mode} preserves the original error and approval and removes the rejected grant`, async (t) => {
    const { db, dir, src } = fixture(t);
    const id = palAdd(db, {
      title: "approved artifact",
      check: { type: "file-exists", path: src },
    });
    const before = palList(db, { readOnly: true });
    const directory = join(dir, ".kit-verifier-grants");
    const markers = readdirSync(directory);
    db.exec(`CREATE TEMP TRIGGER reject_configuration BEFORE UPDATE ON pending_actions BEGIN
      SELECT RAISE(${mode}, 'configuration rejected by fixture'); END`);
    assert.throws(
      () => palConfigure(db, id, { type: "file-exists", path: dir }),
      /configuration rejected by fixture/,
    );
    assert.deepEqual(palList(db, { readOnly: true }), before);
    assert.deepEqual(readdirSync(directory), markers);
    db.exec("DROP TRIGGER reject_configuration");
    assert.deepEqual((await palAutoVerify(db, 1)).closed, [id]);
  });
}
