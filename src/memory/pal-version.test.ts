import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it, type TestContext } from "node:test";
import { openMemoryDb, SCHEMA_VERSION } from "./db.js";
import { mergeDb } from "./merge.js";
import { palAdd, palDone, palShow } from "./pal.js";
import { seedLegacyPalDb } from "./pal-fixture.test-support.js";

function fixture(t: TestContext) {
  const previousDevice = process.env.KIT_DEVICE_ID;
  process.env.KIT_DEVICE_ID = "pal-version-fixture";
  const dir = mkdtempSync(join(tmpdir(), "kit-pal-version-"));
  const path = join(dir, "memory.db");
  t.after(() => {
    if (previousDevice === undefined) delete process.env.KIT_DEVICE_ID;
    else process.env.KIT_DEVICE_ID = previousDevice;
    rmSync(dir, { recursive: true, force: true });
  });
  return { path };
}

function version(db: DatabaseSync): unknown {
  return db.prepare("SELECT token FROM pending_action_versions").get()?.token;
}

it("opening an older store backfills local versions without replacing identity or state", (t) => {
  const { path } = fixture(t);
  seedLegacyPalDb(path, [
    {
      id: "old",
      title: "old work",
      origin_device: "legacy-device",
      origin_root: "/legacy/project",
    },
  ]);
  const old = new DatabaseSync(path);
  const before = (() => {
    try {
      old.exec(`
        ALTER TABLE pending_actions ADD COLUMN sync_id TEXT;
        ALTER TABLE pending_actions ADD COLUMN origin_id TEXT;
        UPDATE pending_actions SET sync_id = '0123456789abcdef0123456789abcdef',
          origin_id = 'original-id';
        UPDATE schema_meta SET version = 11;
      `);
      return old.prepare("SELECT * FROM pending_actions").get()!;
    } finally {
      old.close();
    }
  })();
  const migrated = openMemoryDb(path);
  try {
    assert.match(String(version(migrated)), /^[a-f0-9]{32}$/);
    const after = migrated.prepare("SELECT * FROM pending_actions").get()!;
    assert.deepEqual(Object.fromEntries(Object.keys(before).map((key) => [key, after[key]])), {
      ...before,
    });
    assert.deepEqual(palShow(migrated, "old")?.origin, {
      id: "original-id",
      device: "legacy-device",
      root: "/legacy/project",
    });
    assert.equal(
      migrated.prepare("SELECT version FROM schema_meta").get()!.version,
      SCHEMA_VERSION,
    );
  } finally {
    migrated.close();
  }
});

it("ordinary reopen and read-only inspection do not invalidate the action version", (t) => {
  const { path } = fixture(t);
  const first = openMemoryDb(path);
  palAdd(first, { title: "stable work" });
  const before = first.prepare("SELECT * FROM pending_actions").get();
  const initial = version(first);
  first.close();
  const second = openMemoryDb(path);
  try {
    assert.deepEqual(second.prepare("SELECT * FROM pending_actions").get(), before);
    assert.equal(version(second), initial);
  } finally {
    second.close();
  }
  const reader = new DatabaseSync(path, { readOnly: true });
  try {
    assert.deepEqual(reader.prepare("SELECT * FROM pending_actions").get(), before);
    assert.equal(version(reader), initial);
  } finally {
    reader.close();
  }
});

it("recursive triggers reject unrecorded SQL updates but version valid PAL transitions", (t) => {
  const { path } = fixture(t);
  const db = openMemoryDb(path);
  try {
    db.exec("PRAGMA recursive_triggers = ON");
    const id = palAdd(db, { title: "SQL work" });
    const before = version(db);
    const history = palShow(db, id, { history: true });
    assert.throws(() => db.exec("UPDATE pending_actions SET title = title"), /Kit causal writer/);
    assert.equal(version(db), before);
    assert.deepEqual(palShow(db, id, { history: true }), history);
    assert.equal(palDone(db, id), true);
    const after = version(db);
    assert.match(String(after), /^[a-f0-9]{32}$/);
    assert.notEqual(after, before);
    assert.equal(palShow(db, id)?.heads[0].state.status, "closed");
  } finally {
    db.close();
  }
});

it("imported action versions are local, and repeated import does not invalidate unchanged work", (t) => {
  const { path } = fixture(t);
  const source = openMemoryDb(path);
  const target = openMemoryDb(":memory:");
  try {
    palAdd(source, { title: "portable work" });
    const origin = source.prepare("SELECT * FROM pending_actions").get()!;
    mergeDb(target, path);
    const imported = target.prepare("SELECT * FROM pending_actions").get()!;
    const initial = version(target);
    assert.equal(imported.sync_id, origin.sync_id);
    assert.notEqual(initial, version(source));
    mergeDb(target, path);
    assert.deepEqual(target.prepare("SELECT * FROM pending_actions").get(), imported);
    assert.equal(version(target), initial);
  } finally {
    source.close();
    target.close();
  }
});
