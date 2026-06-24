import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SCHEMA_VERSION,
  openMemoryDb,
  upsertSession,
  insertMessage,
  searchMessages,
  getStats,
  recordQuery,
  dailyActivity,
  toFtsMatchQuery,
} from "./db.js";

describe("memory db", () => {
  const fresh = () => openMemoryDb(":memory:");

  it("creates schema and records the version", () => {
    const db = fresh();
    const row = db.prepare("SELECT version FROM schema_meta LIMIT 1").get() as {
      version: number;
    };
    assert.equal(row.version, SCHEMA_VERSION);
    db.close();
  });

  it("inserts a message and finds it via FTS5", () => {
    const db = fresh();
    upsertSession(db, { sessionId: "s1", harness: "claude-code", project: "/repo" });
    const added = insertMessage(db, {
      uuid: "u1",
      sessionId: "s1",
      type: "user",
      role: "user",
      content: "decision about October pricing",
    });
    assert.equal(added, true);
    const hits = searchMessages(db, "october");
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.uuid, "u1");
    db.close();
  });

  describe("toFtsMatchQuery (FTS5 query sanitization)", () => {
    it("quotes + prefix-matches each term, joined by implicit AND", () => {
      assert.equal(toFtsMatchQuery("vault secret"), '"vault"* "secret"*');
    });
    it("neutralizes FTS5 operators in terms (hyphen, colon)", () => {
      assert.equal(toFtsMatchQuery("auto-close foo:bar"), '"auto-close"* "foo:bar"*');
    });
    it("escapes embedded double-quotes by doubling them", () => {
      assert.equal(toFtsMatchQuery('say "hi"'), '"say"* """hi"""*');
    });
    it("returns empty string for blank input", () => {
      assert.equal(toFtsMatchQuery("   "), "");
    });
  });

  it("does not crash on queries with FTS5 special chars (regression)", () => {
    const db = fresh();
    upsertSession(db, { sessionId: "s1", harness: "claude-code", project: "/repo" });
    insertMessage(db, {
      uuid: "u1",
      sessionId: "s1",
      type: "assistant",
      role: "assistant",
      content: "the auto-close verify type closes a config:foo pal item",
    });
    // Each of these would throw "no such column: …" against a raw FTS5 MATCH.
    for (const q of ["auto-close", "config:foo", 'say "hi"', "a OR b", "x*"]) {
      assert.doesNotThrow(() => searchMessages(db, q), `crashed on: ${q}`);
    }
    // And it still finds the row via the sanitized terms.
    assert.equal(searchMessages(db, "auto-close config").length, 1);
    assert.equal(searchMessages(db, "   ").length, 0); // blank → no query
    db.close();
  });

  it("is idempotent on message uuid (one row per message)", () => {
    const db = fresh();
    upsertSession(db, { sessionId: "s1", harness: "claude-code" });
    const first = insertMessage(db, {
      uuid: "dup",
      sessionId: "s1",
      type: "user",
      content: "hello",
    });
    const second = insertMessage(db, {
      uuid: "dup",
      sessionId: "s1",
      type: "user",
      content: "hello",
    });
    assert.equal(first, true);
    assert.equal(second, false);
    assert.equal(getStats(db).messages, 1);
    db.close();
  });

  it("FTS5 does not match unrelated content", () => {
    const db = fresh();
    upsertSession(db, { sessionId: "s1", harness: "claude-code" });
    insertMessage(db, {
      uuid: "u1",
      sessionId: "s1",
      type: "user",
      content: "totally unrelated note",
    });
    assert.equal(searchMessages(db, "october").length, 0);
    db.close();
  });

  it("getStats counts sessions, messages and open pending actions", () => {
    const db = fresh();
    upsertSession(db, { sessionId: "s1", harness: "claude-code" });
    insertMessage(db, { uuid: "u1", sessionId: "s1", type: "user", content: "a" });
    insertMessage(db, { uuid: "u2", sessionId: "s1", type: "assistant", content: "b" });
    db.prepare("INSERT INTO pending_actions(id, title) VALUES ('p1', 'do thing')").run();
    const stats = getStats(db);
    assert.equal(stats.sessions, 1);
    assert.equal(stats.messages, 2);
    assert.equal(stats.pendingOpen, 1);
    db.close();
  });

  it("getStats breaks sessions down by harness, descending", () => {
    const db = fresh();
    upsertSession(db, { sessionId: "c1", harness: "claude-code" });
    upsertSession(db, { sessionId: "c2", harness: "claude-code" });
    upsertSession(db, { sessionId: "x1", harness: "codex" });
    const { byHarness } = getStats(db);
    assert.deepEqual(byHarness, [
      { harness: "claude-code", sessions: 2 },
      { harness: "codex", sessions: 1 },
    ]);
    db.close();
  });

  it("search scopes to a project by cwd (and global sees all)", () => {
    const db = fresh();
    upsertSession(db, { sessionId: "s1", harness: "claude-code" });
    insertMessage(db, {
      uuid: "a",
      sessionId: "s1",
      type: "user",
      content: "october pricing for app-a",
      cwd: "/repo/app-a",
    });
    insertMessage(db, {
      uuid: "b",
      sessionId: "s1",
      type: "user",
      content: "october pricing for app-b",
      cwd: "/repo/app-b",
    });
    insertMessage(db, {
      uuid: "c",
      sessionId: "s1",
      type: "user",
      content: "october deep in app-a",
      cwd: "/repo/app-a/src",
    });
    assert.equal(searchMessages(db, "october").length, 3); // global — no scope
    const scoped = searchMessages(db, "october", { projectPath: "/repo/app-a" });
    assert.equal(scoped.length, 2); // exact root + subdir, not /repo/app-b
    assert.deepEqual(scoped.map((h) => h.uuid).sort(), ["a", "c"]);
    db.close();
  });

  it("getStats aggregates tokens (incl cache-hit) from message rows", () => {
    const db = fresh();
    upsertSession(db, { sessionId: "s1", harness: "claude-code" });
    insertMessage(db, {
      uuid: "a",
      sessionId: "s1",
      type: "assistant",
      model: "claude-opus-4-8",
      content: "hi",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 300,
      cacheCreationTokens: 100,
    });
    const s = getStats(db);
    assert.equal(s.tokens.totalTokens, 150);
    assert.equal(s.tokens.cacheReadTokens, 300);
    assert.equal(s.tokens.cacheHitRatio, 0.6); // 300/(100+300+100)
    assert.equal(s.tokens.perMessage, 150); // 150 tokens / 1 message
    assert.equal(s.tokens.byModel[0].model, "claude-opus-4-8");
    db.close();
  });

  it("recordQuery feeds getStats recall counts + top terms", () => {
    const db = fresh();
    recordQuery(db, { query: "stripe webhook", hitCount: 3, projectPath: "/repo" });
    recordQuery(db, { query: "stripe webhook", hitCount: 1 });
    recordQuery(db, { query: "rls policy", hitCount: 0 });
    const s = getStats(db);
    assert.equal(s.recalls.total, 3);
    assert.equal(s.recalls.last7d, 3); // all just inserted
    assert.equal(s.recalls.distinctQueries, 2);
    assert.equal(s.recalls.topTerms[0].query, "stripe webhook");
    assert.equal(s.recalls.topTerms[0].count, 2);
    db.close();
  });

  it("getStats splits logical vs sidechain sessions", () => {
    const db = fresh();
    upsertSession(db, { sessionId: "main", harness: "claude-code", isAgentSidechain: false });
    upsertSession(db, { sessionId: "sub", harness: "claude-code", isAgentSidechain: true });
    const s = getStats(db);
    assert.equal(s.sessions, 2);
    assert.equal(s.sessionsBreakdown.logical, 1);
    assert.equal(s.sessionsBreakdown.sidechain, 1);
    db.close();
  });

  it("dailyActivity groups messages by day", () => {
    const db = fresh();
    upsertSession(db, { sessionId: "s1", harness: "claude-code" });
    insertMessage(db, {
      uuid: "a",
      sessionId: "s1",
      type: "user",
      content: "x",
      timestamp: "2026-06-20T10:00:00.000Z",
    });
    insertMessage(db, {
      uuid: "b",
      sessionId: "s1",
      type: "user",
      content: "y",
      timestamp: "2026-06-20T11:00:00.000Z",
    });
    // far-past row is outside the default 90-day window
    insertMessage(db, {
      uuid: "old",
      sessionId: "s1",
      type: "user",
      content: "z",
      timestamp: "2000-01-01T00:00:00.000Z",
    });
    const days = dailyActivity(db, 100_000); // wide window to capture both buckets
    const jun20 = days.find((d) => d.day === "2026-06-20");
    assert.equal(jun20?.count, 2);
    db.close();
  });
});

describe("redaction-at-capture (KIT_MEMORY_REDACT)", () => {
  const SECRET = ["sk", "live", "Z".repeat(40)].join("_");
  function insertAndRead(redact: boolean): string {
    const prev = process.env.KIT_MEMORY_REDACT;
    if (redact) process.env.KIT_MEMORY_REDACT = "1";
    else delete process.env.KIT_MEMORY_REDACT;
    try {
      const db = openMemoryDb(":memory:");
      upsertSession(db, { sessionId: "s", harness: "claude-code" });
      insertMessage(db, { uuid: "u", sessionId: "s", type: "user", content: `key ${SECRET}` });
      const row = db.prepare("SELECT content FROM messages WHERE uuid = ?").get("u") as {
        content: string;
      };
      db.close();
      return row.content;
    } finally {
      if (prev === undefined) delete process.env.KIT_MEMORY_REDACT;
      else process.env.KIT_MEMORY_REDACT = prev;
    }
  }

  it("stores raw content by default (opt-in off)", () => {
    assert.ok(insertAndRead(false).includes(SECRET));
  });

  it("masks secrets at capture when KIT_MEMORY_REDACT=1", () => {
    const c = insertAndRead(true);
    assert.ok(!c.includes(SECRET), "secret must not be persisted");
    assert.match(c, /\[REDACTED\]/);
  });
});
