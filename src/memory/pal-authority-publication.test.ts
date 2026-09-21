import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import { dirname, join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { it } from "node:test";
import { openMemoryDb } from "./db.js";
import { palAdd, palAutoVerify, palConfigure, palList } from "./pal.js";
import { fixture, restoreMocks } from "./backup.test-support.js";

it("a failed exclusive approval write never removes a pre-existing file", async (t) => {
  const { src, track } = fixture(t);
  const previous = process.env.KIT_DEVICE_ID;
  process.env.KIT_DEVICE_ID = "grant-publication-fixture";
  t.after(() => {
    restoreMocks(t);
    if (previous === undefined) delete process.env.KIT_DEVICE_ID;
    else process.env.KIT_DEVICE_ID = previous;
  });
  const db = track(openMemoryDb(src));
  t.mock.method(crypto, "randomBytes", (size: number) => Buffer.alloc(size, 0x17));
  syncBuiltinESMExports();
  const id = palAdd(db, {
    title: "configure existing task",
    check: { type: "file-exists", path: src },
  });
  const before = palList(db, { readOnly: true });
  const directory = join(dirname(src), ".kit-verifier-grants");
  const markers = fs.readdirSync(directory);
  assert.equal(markers.length, 1);
  const collision = join(directory, markers[0]!);
  const approved = fs.readFileSync(collision, "utf8");
  assert.throws(() => palConfigure(db, id, { type: "file-exists", path: src }), { code: "EEXIST" });
  assert.equal(fs.readFileSync(collision, "utf8"), approved);
  assert.deepEqual(palList(db, { readOnly: true }), before);
  restoreMocks(t);
  assert.deepEqual((await palAutoVerify(db, 1)).closed, [id]);
});

it(
  "a group-writable approval marker is not trusted as local authority",
  {
    skip:
      process.platform === "win32"
        ? "POSIX mode bits do not establish Windows ACL integrity"
        : false,
  },
  async (t) => {
    const { src, track } = fixture(t);
    const previous = process.env.KIT_DEVICE_ID;
    process.env.KIT_DEVICE_ID = "grant-permissions-fixture";
    t.after(() => {
      if (previous === undefined) delete process.env.KIT_DEVICE_ID;
      else process.env.KIT_DEVICE_ID = previous;
    });
    const db = track(openMemoryDb(src));
    palAdd(db, { title: "local artifact", check: { type: "file-exists", path: src } });
    const before = palList(db, { readOnly: true });
    const directory = join(dirname(src), ".kit-verifier-grants");
    const markers = fs.readdirSync(directory);
    assert.equal(markers.length, 1);
    const marker = join(directory, markers[0]!);
    fs.chmodSync(marker, 0o666);
    const result = await palAutoVerify(db, 1);
    assert.equal(result.checked, 0);
    assert.deepEqual(result.closed, []);
    assert.equal(result.unverified[0]?.reason, "no-local-approval");
    assert.deepEqual(palList(db, { readOnly: true }), before);
  },
);
