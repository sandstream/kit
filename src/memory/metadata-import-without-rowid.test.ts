import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { getStats, recentMessages, searchMessages } from "./db.js";
import { scanDbForInjection, scanDbForSecrets } from "./scan.js";
import {
  APIS,
  INJECTION,
  metadataFixture,
  MODES,
  seedMessage,
  type MemoryDb,
} from "./metadata-import.test-support.js";

function withoutRowid(db: MemoryDb, table: "sessions" | "messages"): void {
  const key = table === "sessions" ? "session_id" : "uuid";
  const columns = (
    db.prepare(`PRAGMA table_info(${table})`).all() as {
      name: string;
      type: string;
    }[]
  ).filter((column) => column.name !== "id");
  const names = columns.map((column) => column.name).join(", ");
  const definitions = columns
    .map((column) => `${column.name} ${column.type}${column.name === key ? " PRIMARY KEY" : ""}`)
    .join(", ");
  db.exec(`
    CREATE TABLE metadata_rows (${definitions}) WITHOUT ROWID;
    INSERT INTO metadata_rows (${names}) SELECT ${names} FROM ${table};
    DROP TABLE ${table};
    ALTER TABLE metadata_rows RENAME TO ${table};
  `);
}

for (const mode of MODES) {
  for (const api of APIS) {
    for (const table of ["sessions", "messages"] as const) {
      it(`${mode}/${api}: refuses quarantine-only ${table} metadata without row identifiers`, (t) => {
        const files = metadataFixture(t);
        const target = files.target();
        seedMessage(target, "same-session", files.root);
        const before = recentMessages(target);
        const beforeStats = getStats(target);
        const incoming = files.exportMemory(mode, "same-session", (db) => {
          withoutRowid(db, table);
          db.exec("UPDATE messages SET uuid = 'quarantined-new', quarantined = 1");
          db.prepare(
            table === "sessions"
              ? "UPDATE sessions SET harness = ?"
              : "UPDATE messages SET model = ?",
          ).run(INJECTION);
        });

        assert.throws(
          () => files.importMemory(target, incoming.path, api),
          /refusing to merge: incoming memory has .*high-confidence injection/,
        );
        assert.deepEqual(recentMessages(target), before);
        assert.deepEqual(searchMessages(target, "metadatarecall"), before);
        assert.deepEqual(getStats(target), beforeStats);
      });
    }
  }
}

for (const mode of MODES) {
  for (const api of APIS) {
    for (const table of ["sessions", "messages"] as const) {
      it(`${mode}/${api}: scans generated ${table} metadata without row identifiers`, (t) => {
        const files = metadataFixture(t);
        const target = files.target();
        const field = table === "sessions" ? "harness" : "model";
        const incoming = files.exportMemory(mode, "incoming", (db) => {
          withoutRowid(db, table);
          db.exec(`ALTER TABLE ${table} DROP COLUMN ${field}`);
          db.exec(
            `ALTER TABLE ${table} ADD COLUMN ${field} TEXT GENERATED ALWAYS AS ('${INJECTION}') VIRTUAL`,
          );
        });
        assert.throws(
          () => files.importMemory(target, incoming.path, api),
          /refusing to merge: incoming memory has .*high-confidence injection/,
        );
        assert.equal(getStats(target).messages, 0);
        assert.equal(getStats(target).sessions, 0);
      });

      it(`${mode}/${api}: preserves benign ${table} without row identifiers and the raw archive`, (t) => {
        const files = metadataFixture(t);
        const incoming = files.exportMemory(mode, "incoming", (db) => {
          seedMessage(db, "archived", files.root);
          db.exec("UPDATE messages SET quarantined = 1 WHERE session_id = 'archived'");
          withoutRowid(db, table);
        });
        const sourceBefore = readFileSync(incoming.sourcePath);
        const encryptedBefore = readFileSync(incoming.path);
        const target = files.target();
        assert.equal(files.importMemory(target, incoming.path, api).messages, 2);
        assert.deepEqual(
          recentMessages(target).map((hit) => hit.sessionId),
          ["incoming"],
        );
        const archived = searchMessages(target, "metadatarecall", { includeQuarantined: true });
        assert.equal(archived.length, 2);
        assert.equal(
          archived.find((hit) => hit.sessionId === "archived")?.content,
          "metadatarecall clean handoff archived",
        );
        for (const hit of archived) {
          assert.equal(hit.harness, "codex");
          assert.equal(hit.cwd, files.root);
          assert.equal(hit.gitBranch, "synthetic-branch");
          assert.equal(hit.timestamp, "2026-01-02T00:00:00Z");
        }
        assert.deepEqual(getStats(target).tokens.byModel, [
          { model: "synthetic-model", messages: 2, inputTokens: 2, outputTokens: 0 },
        ]);
        assert.deepEqual(readFileSync(incoming.sourcePath), sourceBefore);
        assert.deepEqual(readFileSync(incoming.path), encryptedBefore);
      });
    }
  }
}

for (const expression of ["unavailable_metadata()", "json_extract('invalid', '$')"]) {
  it(`scanners surface unreadable metadata instead of a clean result: ${expression}`, (t) => {
    const db = new DatabaseSync(":memory:");
    t.after(() => db.close());
    db.exec(`CREATE VIEW sessions AS SELECT 'session-1' AS session_id, ${expression} AS harness`);
    for (const scan of [scanDbForInjection, scanDbForSecrets]) {
      assert.throws(() => scan(db), /no such function|malformed JSON/);
    }
  });
}
