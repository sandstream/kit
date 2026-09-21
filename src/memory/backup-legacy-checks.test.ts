import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { openMemoryDb } from "./db.js";
import { palAdd } from "./pal.js";
import { fixture, modes } from "./backup.test-support.js";

for (const mode of modes) {
  it(`${mode.name} raw recovery refuses an old executable verifier before replacing destination bytes`, (t) => {
    const { src, blob, dest } = fixture(t);
    const previousDevice = process.env.KIT_DEVICE_ID;
    process.env.KIT_DEVICE_ID = "old-backup-fixture";
    t.after(() => {
      if (previousDevice === undefined) delete process.env.KIT_DEVICE_ID;
      else process.env.KIT_DEVICE_ID = previousDevice;
    });
    const source = openMemoryDb(src);
    try {
      palAdd(source, { title: "old automatic check", check: { type: "file-exists", path: src } });
      source.exec(`DROP TRIGGER pending_check_legacy_insert;
        DROP TRIGGER pending_check_legacy_update;
        UPDATE pending_actions SET verify_check=verify_definition;
        ALTER TABLE pending_actions DROP COLUMN verify_definition;
        UPDATE schema_meta SET version=13`);
    } finally {
      source.close();
    }
    mode.backup(src, blob);
    assert.throws(() => mode.restore(blob, dest), /legacy verification.*memory sync/i);
    assert.throws(() => readFileSync(dest), { code: "ENOENT" });
    writeFileSync(dest, "previous destination");
    assert.throws(() => mode.restore(blob, dest), /legacy verification.*memory sync/i);
    assert.equal(readFileSync(dest, "utf8"), "previous destination");
  });
}

const legacySchemas = [
  ["generated check", "CREATE TABLE pending_actions (kind TEXT, verify_check TEXT AS ('{}'))"],
  [
    "generated command",
    "CREATE TABLE pending_actions (kind TEXT, verify_cmd TEXT AS ('echo unsafe'))",
  ],
  ["uppercase check", "CREATE TABLE pending_actions (kind TEXT, VERIFY_CHECK TEXT DEFAULT '{}')"],
  [
    "uppercase command",
    "CREATE TABLE pending_actions (kind TEXT, VERIFY_CMD TEXT DEFAULT 'echo unsafe')",
  ],
  [
    "malformed closed manual check",
    "CREATE TABLE pending_actions (kind TEXT, status TEXT DEFAULT 'closed', verify_check TEXT DEFAULT '')",
  ],
  [
    "null-returning view",
    "CREATE VIEW pending_actions AS SELECT NULL AS verify_check, 'auto' AS kind",
  ],
  [
    "uppercase null-returning view",
    "CREATE VIEW PENDING_ACTIONS AS SELECT NULL AS verify_check, 'auto' AS kind",
  ],
  [
    "virtual table with null check",
    "CREATE VIRTUAL TABLE pending_actions USING fts5(kind, verify_check)",
  ],
] as const;

for (const mode of modes) {
  for (const [name, schema] of legacySchemas) {
    it(`${mode.name} recovery refuses ${name} without publishing or leaving staging files`, (t) => {
      const { dir, src, blob, dest } = fixture(t);
      const source = new DatabaseSync(src);
      try {
        source.exec(schema);
        if (!schema.startsWith("CREATE VIEW")) {
          source.exec("INSERT INTO pending_actions (kind) VALUES ('manual')");
        }
      } finally {
        source.close();
      }
      mode.backup(src, blob);
      const contents = readdirSync(dir).sort();
      assert.throws(() => mode.restore(blob, dest), /memory sync/i);
      assert.throws(() => readFileSync(dest), { code: "ENOENT" });
      assert.deepEqual(readdirSync(dir).sort(), contents);
      writeFileSync(dest, "previous destination");
      assert.throws(() => mode.restore(blob, dest), /memory sync/i);
      assert.equal(readFileSync(dest, "utf8"), "previous destination");
      assert.deepEqual(readdirSync(dir).sort(), [...contents, "restored.db"].sort());
    });
  }
}
