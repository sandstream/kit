import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { openMemoryDb, openMemoryDbReadOnly, SCHEMA_VERSION, upsertSession } from "./db.js";
import { fixture, keypair, modes, passphrase } from "./backup.test-support.js";
import { mergeDb } from "./merge.js";
import { palAdd, palShow } from "./pal.js";
import { saveMemoryKey } from "./backup.js";
import { syncFromExport } from "./sync.js";
import { fixture as cliFixture } from "./pal-cli.test-support.js";

it("refuses a newer memory schema before migration or journal changes", (t) => {
  const { src } = fixture(t);
  const future = new DatabaseSync(src);
  future.exec(`CREATE TABLE schema_meta (version INTEGER NOT NULL);
    CREATE TABLE future_only (payload TEXT NOT NULL);
    INSERT INTO future_only VALUES ('keep this unknown format')`);
  future.prepare("INSERT INTO schema_meta VALUES (?)").run(SCHEMA_VERSION + 1);
  future.close();
  const before = readFileSync(src);
  assert.throws(() => {
    const db = openMemoryDb(src);
    db.close();
  }, /newer memory schema.*update kit/i);
  assert.deepEqual(readFileSync(src), before);
});

it("refuses unsupported source and destination schemas instead of merging their known columns", (t) => {
  const { src, dest, track } = fixture(t);
  const source = track(openMemoryDb(src));
  upsertSession(source, { sessionId: "future-session", harness: "test" });
  palAdd(source, { title: "future claim state" });
  source.prepare("UPDATE schema_meta SET version=?").run(SCHEMA_VERSION + 1);
  const target = track(openMemoryDb(dest));
  const id = palAdd(target, { title: "retain local task" });
  const before = palShow(target, id, { history: true });
  const changes = target.prepare("SELECT total_changes() AS count").get();
  assert.throws(() => mergeDb(target, src), /newer memory schema.*update kit/i);
  assert.deepEqual(target.prepare("SELECT total_changes() AS count").get(), changes);
  assert.deepEqual(palShow(target, id, { history: true }), before);
  assert.throws(() => mergeDb(source, dest), /newer memory schema.*update kit/i);
});

it("read-only inspection refuses a newer schema without falling back to an unchecked open", (t) => {
  const { src } = fixture(t);
  const future = openMemoryDb(src);
  future.prepare("UPDATE schema_meta SET version=?").run(SCHEMA_VERSION + 1);
  future.exec("PRAGMA journal_mode=DELETE");
  future.close();
  const before = readFileSync(src);
  assert.throws(() => {
    const db = openMemoryDbReadOnly(src);
    db.close();
  }, /newer memory schema.*update kit/i);
  assert.deepEqual(readFileSync(src), before);
});

for (const [label, sql] of [
  ["empty", "CREATE TABLE schema_meta (version INTEGER)"],
  [
    "duplicate",
    "CREATE TABLE schema_meta (version INTEGER); INSERT INTO schema_meta VALUES (1),(2)",
  ],
  ["zero", "CREATE TABLE schema_meta (version INTEGER); INSERT INTO schema_meta VALUES (0)"],
  ["fractional", "CREATE TABLE schema_meta (version REAL); INSERT INTO schema_meta VALUES (1.5)"],
  ["text", "CREATE TABLE schema_meta (version TEXT); INSERT INTO schema_meta VALUES ('1')"],
  ["null", "CREATE TABLE schema_meta (version INTEGER); INSERT INTO schema_meta VALUES (NULL)"],
  ["missing column", "CREATE TABLE schema_meta (unknown TEXT)"],
  ["view", "CREATE VIEW schema_meta AS SELECT 1 AS version"],
] as const) {
  it(`refuses ${label} schema metadata without interpreting it as a legacy store`, (t) => {
    const { src, track } = fixture(t);
    const invalid = new DatabaseSync(src);
    invalid.exec(sql);
    invalid.close();
    const before = readFileSync(src);
    for (const open of [openMemoryDb, openMemoryDbReadOnly]) {
      assert.throws(() => {
        const db = open(src);
        db.close();
      }, /invalid memory schema version/i);
      assert.deepEqual(readFileSync(src), before);
    }
    const target = track(openMemoryDb(":memory:"));
    const changes = target.prepare("SELECT total_changes() AS count").get();
    assert.throws(() => mergeDb(target, src), /invalid memory schema version/i);
    assert.deepEqual(target.prepare("SELECT total_changes() AS count").get(), changes);
  });
}

it("recognizes SQLite's case-insensitive metadata names", (t) => {
  const { src } = fixture(t);
  const future = new DatabaseSync(src);
  future.exec("CREATE TABLE SCHEMA_META (VERSION INTEGER NOT NULL)");
  future.prepare("INSERT INTO SCHEMA_META VALUES (?)").run(SCHEMA_VERSION + 1);
  future.close();
  assert.throws(() => {
    const db = openMemoryDb(src);
    db.close();
  }, /newer memory schema.*update kit/i);
});

it("case-insensitive causal metadata cannot hide missing history tables", (t) => {
  const { src, track } = fixture(t);
  const damaged = new DatabaseSync(src);
  damaged.exec(
    "CREATE TABLE SCHEMA_META (VERSION INTEGER NOT NULL); INSERT INTO SCHEMA_META VALUES (15)",
  );
  damaged.close();
  const target = track(openMemoryDb(":memory:"));
  assert.throws(() => mergeDb(target, src), /causal history is missing/i);
  assert.throws(() => {
    const db = openMemoryDb(src);
    db.close();
  }, /causal history is missing/i);
});

it("a declared ownership-aware store cannot silently recreate missing owner storage", (t) => {
  const { src, track } = fixture(t);
  const damaged = openMemoryDb(src);
  damaged.exec("ALTER TABLE pending_actions DROP COLUMN claim_owner; PRAGMA journal_mode=DELETE");
  damaged.close();
  const before = readFileSync(src);
  for (const open of [openMemoryDb, openMemoryDbReadOnly]) {
    assert.throws(() => {
      const db = open(src);
      db.close();
    }, /claim ownership storage is missing/i);
    assert.deepEqual(readFileSync(src), before);
  }
  const target = track(openMemoryDb(":memory:"));
  const changes = target.prepare("SELECT total_changes() AS n").get();
  assert.throws(() => mergeDb(target, src), /claim ownership storage is missing/i);
  assert.deepEqual(target.prepare("SELECT total_changes() AS n").get(), changes);
});

for (const mode of modes) {
  it(`${mode.name} can archive newer bytes but cannot import an unsupported schema`, (t) => {
    const { src, dest, blob, dir, track } = fixture(t);
    const previous = process.env.KIT_MEMORY_DIR;
    process.env.KIT_MEMORY_DIR = dir;
    t.after(() => {
      if (previous === undefined) delete process.env.KIT_MEMORY_DIR;
      else process.env.KIT_MEMORY_DIR = previous;
    });
    saveMemoryKey(keypair.privateJwk);
    const source = track(openMemoryDb(src));
    palAdd(source, { title: "do not drop future ownership" });
    source.prepare("UPDATE schema_meta SET version=?").run(SCHEMA_VERSION + 1);
    mode.backup(src, blob);
    mode.restore(blob, dest);
    const archived = track(new DatabaseSync(dest, { readOnly: true }));
    assert.equal(
      archived.prepare("SELECT version FROM schema_meta").get()?.version,
      SCHEMA_VERSION + 1,
    );
    const before = readFileSync(blob);
    const target = track(openMemoryDb(":memory:"));
    const changes = target.prepare("SELECT total_changes() AS count").get();
    for (const allowUnsafe of [false, true]) {
      assert.throws(
        () => syncFromExport(target, blob, { passphrase, allowUnsafe }),
        /newer memory schema.*update kit/i,
      );
      assert.deepEqual(target.prepare("SELECT total_changes() AS count").get(), changes);
      assert.deepEqual(readFileSync(blob), before);
    }
  });
}

it("CLI reports unsupported schema for both PAL inspection and mutation", async (t) => {
  const { dbPath, cli } = await cliFixture(t);
  const db = openMemoryDb(dbPath);
  const id = palAdd(db, { title: "retain task for newer client" });
  db.prepare("UPDATE schema_meta SET version=?").run(SCHEMA_VERSION + 1);
  db.exec("PRAGMA journal_mode=DELETE");
  db.close();
  const before = readFileSync(dbPath);
  for (const args of [["show", id], ["list"], ["done", id]]) {
    await assert.rejects(cli(...args, "--json"), (error: unknown) => {
      const result = error as { code: number; stdout: string; stderr: string };
      assert.notEqual(result.code, 0);
      assert.match(result.stdout + result.stderr, /newer memory schema.*update kit/i);
      assert.doesNotMatch(result.stdout, /"status":"applied"/);
      return true;
    });
    assert.deepEqual(readFileSync(dbPath), before);
  }
});
