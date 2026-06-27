import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openMemoryDb, searchMessages } from "./db.js";
import { indexOpenCodeSessions } from "./opencode.js";

/** Lay out a minimal OpenCode storage tree matching the documented flat-JSON format. */
function writeFixture(root: string): void {
  const storage = join(root, "storage");
  const ses = "ses_abc";
  const sessionDir = join(storage, "session", "projhash");
  const msgDir = join(storage, "message", ses);
  const partDir = join(storage, "part", ses, "msg_1");
  for (const d of [sessionDir, msgDir, partDir]) mkdirSync(d, { recursive: true });

  writeFileSync(
    join(sessionDir, `${ses}.json`),
    JSON.stringify({ id: ses, directory: "/home/dev/myproject", title: "t" }),
  );
  writeFileSync(
    join(msgDir, "msg_1.json"),
    JSON.stringify({
      id: "msg_1",
      sessionID: ses,
      role: "user",
      time: { created: 1_700_000_000_000 },
    }),
  );
  // Content lives in a separate part file, grouped via its messageID.
  writeFileSync(
    join(partDir, "prt_1.json"),
    JSON.stringify({
      id: "prt_1",
      sessionID: ses,
      messageID: "msg_1",
      type: "text",
      text: "deploy the staging cluster",
    }),
  );
  // An ignored/empty part and a non-text part must NOT contribute content.
  writeFileSync(
    join(partDir, "prt_2.json"),
    JSON.stringify({ id: "prt_2", messageID: "msg_1", type: "text", text: "", ignored: true }),
  );
  writeFileSync(
    join(partDir, "prt_3.json"),
    JSON.stringify({ id: "prt_3", messageID: "msg_1", type: "tool", text: "n/a" }),
  );
}

describe("indexOpenCodeSessions", () => {
  let dir: string;
  let db: DatabaseSync;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "kit-opencode-"));
    process.env.KIT_OPENCODE_DIR = dir;
    writeFixture(dir);
    db = openMemoryDb(":memory:");
  });

  after(() => {
    db.close();
    delete process.env.KIT_OPENCODE_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("indexes a message, joining only its text parts", () => {
    const res = indexOpenCodeSessions(db);
    assert.equal(res.messages, 1, "one message indexed");
    assert.equal(res.sessions, 1, "one session recorded");
    const hits = searchMessages(db, "staging cluster");
    assert.equal(hits.length, 1);
    assert.equal(
      hits[0].content,
      "deploy the staging cluster",
      "only the text part, no tool/ignored parts",
    );
  });

  it("is idempotent on re-run (stable uuids dedupe)", () => {
    const res = indexOpenCodeSessions(db);
    assert.equal(res.messages, 0, "re-run adds nothing");
  });

  it("is a safe no-op when the storage dir is absent", () => {
    const empty = openMemoryDb(":memory:");
    process.env.KIT_OPENCODE_DIR = join(dir, "does-not-exist");
    const res = indexOpenCodeSessions(empty);
    assert.deepEqual(res, { files: 0, sessions: 0, messages: 0, toolUses: 0, filesSkipped: 0 });
    process.env.KIT_OPENCODE_DIR = dir;
    empty.close();
  });
});

/**
 * Build a minimal `opencode.db` matching the verified opencode-ai@1.17.x schema:
 *   session(id, directory), message(id, session_id, time_created, data),
 *   part(id, message_id, session_id, data)  — data is the serialized Message/Part JSON.
 */
function writeSqliteFixture(root: string): void {
  const src = new DatabaseSync(join(root, "opencode.db"));
  src.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT);
  `);
  const ses = "ses_sql";
  src.prepare("INSERT INTO session(id, directory) VALUES (?, ?)").run(ses, "/home/dev/myproject");
  src
    .prepare("INSERT INTO message(id, session_id, time_created, data) VALUES (?, ?, ?, ?)")
    .run(
      "msg_1",
      ses,
      1_700_000_000_000,
      JSON.stringify({ id: "msg_1", sessionID: ses, role: "user", time: { created: 1 } }),
    );
  const part = (id: string, data: unknown) =>
    src
      .prepare("INSERT INTO part(id, message_id, session_id, data) VALUES (?, ?, ?, ?)")
      .run(id, "msg_1", ses, JSON.stringify(data));
  part("prt_1", { type: "text", text: "deploy the staging cluster" });
  part("prt_2", { type: "text", text: "", ignored: true }); // empty/ignored → skip
  part("prt_3", { type: "tool", text: "n/a" }); // non-text → skip
  src.close();
}

describe("indexOpenCodeSessions — SQLite store (current OpenCode)", () => {
  let dir: string;
  let db: DatabaseSync;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "kit-opencode-sql-"));
    process.env.KIT_OPENCODE_DIR = dir;
    writeSqliteFixture(dir);
    db = openMemoryDb(":memory:");
  });

  after(() => {
    db.close();
    delete process.env.KIT_OPENCODE_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("prefers opencode.db and indexes message text from part data blobs", () => {
    const res = indexOpenCodeSessions(db);
    assert.equal(res.messages, 1, "one message indexed from SQLite");
    assert.equal(res.sessions, 1, "one session recorded");
    const hits = searchMessages(db, "staging cluster");
    assert.equal(hits.length, 1);
    assert.equal(
      hits[0].content,
      "deploy the staging cluster",
      "only the text part, no tool/ignored parts",
    );
  });

  it("is idempotent on re-run (stable uuids dedupe)", () => {
    assert.equal(indexOpenCodeSessions(db).messages, 0, "re-run adds nothing");
  });
});
