import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  openMemoryDb,
  upsertSession,
  insertMessage,
  searchMessages,
  forgetMemory,
  countTombstones,
} from "./db.js";

const setup = () => {
  const db = openMemoryDb(":memory:");
  upsertSession(db, { sessionId: "s1", harness: "claude-code", project: "/repo" });
  return db;
};

describe("forgetMemory (verified-forget, G1)", () => {
  it("deletes a row and proves it gone (row + FTS + tombstone)", () => {
    const db = setup();
    insertMessage(db, {
      uuid: "u1",
      sessionId: "s1",
      type: "user",
      role: "user",
      content: "delete me: the quarterly falcon pricing memo",
    });
    // present + searchable first
    assert.equal(searchMessages(db, "falcon").length, 1);

    const proof = forgetMemory(db, "u1", "test");
    assert.equal(proof.found, true);
    assert.equal(proof.rowGone, true);
    assert.equal(proof.ftsConsistent, true);
    assert.equal(proof.tombstoned, true);
    assert.equal(proof.ok, true);

    // row is really gone, and no longer recallable via FTS
    assert.equal(
      (db.prepare("SELECT COUNT(*) c FROM messages WHERE uuid = 'u1'").get() as { c: number }).c,
      0,
    );
    assert.equal(searchMessages(db, "falcon").length, 0);
    db.close();
  });

  it("records a content-hash tombstone (never the content)", () => {
    const db = setup();
    const content = "secret token sk-abc123 in a transcript line";
    insertMessage(db, { uuid: "u1", sessionId: "s1", type: "user", content });
    const proof = forgetMemory(db, "u1");
    const expected = createHash("sha256").update(content, "utf8").digest("hex");
    assert.equal(proof.contentSha256, expected);

    const tomb = db.prepare("SELECT * FROM memory_tombstones WHERE uuid = 'u1'").get() as Record<
      string,
      unknown
    >;
    assert.equal(tomb.content_sha256, expected);
    // the tombstone must NOT carry the plaintext content anywhere
    assert.ok(!JSON.stringify(tomb).includes("sk-abc123"));
    assert.equal(countTombstones(db), 1);
    db.close();
  });

  it("returns found:false / ok:false for a uuid that does not exist", () => {
    const db = setup();
    const proof = forgetMemory(db, "nope");
    assert.deepEqual(
      { found: proof.found, ok: proof.ok, tombstoned: proof.tombstoned },
      { found: false, ok: false, tombstoned: false },
    );
    assert.equal(countTombstones(db), 0);
    db.close();
  });

  it("decrements the session message_count", () => {
    const db = setup();
    insertMessage(db, { uuid: "u1", sessionId: "s1", type: "user", content: "one" });
    insertMessage(db, { uuid: "u2", sessionId: "s1", type: "user", content: "two" });
    const before = (
      db.prepare("SELECT message_count c FROM sessions WHERE session_id = 's1'").get() as {
        c: number;
      }
    ).c;
    forgetMemory(db, "u1");
    const after = (
      db.prepare("SELECT message_count c FROM sessions WHERE session_id = 's1'").get() as {
        c: number;
      }
    ).c;
    assert.equal(after, before - 1);
    db.close();
  });

  it("is safe to call twice — second call reports nothing left to forget", () => {
    const db = setup();
    insertMessage(db, { uuid: "u1", sessionId: "s1", type: "user", content: "gone soon" });
    assert.equal(forgetMemory(db, "u1").ok, true);
    const again = forgetMemory(db, "u1");
    assert.equal(again.found, false);
    assert.equal(again.ok, false);
    assert.equal(countTombstones(db), 1); // still exactly one receipt
    db.close();
  });

  it("forgetting one row leaves siblings intact and recallable", () => {
    const db = setup();
    insertMessage(db, {
      uuid: "u1",
      sessionId: "s1",
      type: "user",
      content: "keep the aardvark note",
    });
    insertMessage(db, {
      uuid: "u2",
      sessionId: "s1",
      type: "user",
      content: "drop the beetle note",
    });
    forgetMemory(db, "u2");
    assert.equal(searchMessages(db, "beetle").length, 0);
    assert.equal(searchMessages(db, "aardvark").length, 1);
    db.close();
  });
});
