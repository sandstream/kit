import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readRunEvidence, readToolCallRows } from "./skill/attribute.js";
import { auditRuntime } from "./skill/adherence.js";

function fixture(modern = true): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE messages (uuid TEXT PRIMARY KEY, session_id TEXT${modern ? ", tool_capture_version INTEGER DEFAULT 0, tool_capture_count INTEGER" : ""});
    CREATE TABLE tool_uses (id INTEGER PRIMARY KEY, message_uuid TEXT, session_id TEXT, tool_name TEXT, tool_input TEXT, timestamp TEXT${modern ? ", call_id TEXT, outcome TEXT DEFAULT 'unknown', outcome_at TEXT" : ""});`);
  const message = db.prepare(`INSERT INTO messages VALUES (?, ?${modern ? ", 1, 1" : ""})`);
  const call = db.prepare(
    `INSERT INTO tool_uses (message_uuid, session_id, tool_name, tool_input, timestamp${modern ? ", outcome" : ""}) VALUES (?, 's1', ?, ?, '2026-11-05T10:00:00Z'${modern ? ", ?" : ""})`,
  );
  for (const [id, tool, input, outcome] of [
    ["skill", "Skill", '{"skill":"x"}', "returned"],
    ["a", "Write", null, "returned"],
    ["b", "Write", null, "error"],
    ["c", "Write", null, "denied"],
    ["d", "Write", null, "conflict"],
    ["e", "Write", null, "unknown"],
  ]) {
    message.run(id, "s1");
    call.run(...[id, tool, input, ...(modern ? [outcome] : [])]);
  }
  return db;
}

describe("runtime database evidence", () => {
  it("reads schema18 outcomes without treating an error as a denial", () => {
    const db = fixture();
    try {
      db.exec("PRAGMA query_only = ON");
      const ev = readRunEvidence(db, "x");
      assert.equal(ev.runs, 1);
      assert.deepEqual(
        ev.actions.map((action) => action.outcome),
        ["returned", "error", "denied", "conflict", "unknown"],
      );
      const report = auditRuntime(["Read"], ev);
      assert.equal(report.summary.violations, 1);
      assert.equal(report.summary.deniedForbidden, 1);
      assert.equal(report.summary.inconclusiveForbidden, 3);
      assert.deepEqual(ev.capture, { complete: true, incompleteMessages: 0 });
    } finally {
      db.close();
    }
  });

  it("reads legacy17 columns as unknown without writing a migration", () => {
    const db = fixture(false);
    try {
      db.exec("PRAGMA user_version = 17; PRAGMA query_only = ON");
      const rows = readToolCallRows(db);
      assert.equal(rows.length, 6);
      assert.ok(rows.every((row) => row.outcome === "unknown"));
      const ev = readRunEvidence(db, "x");
      assert.equal(ev.runs, 0);
      assert.equal(ev.unresolvedInvocations, 1);
      assert.equal(ev.unattributedActions, 5);
      assert.deepEqual(ev.capture, { complete: false, incompleteMessages: 6 });
      const report = auditRuntime(["Read"], ev);
      assert.equal(report.summary.violations, 0);
      assert.deepEqual(
        report.checks.map((check) => check.status),
        ["skip", "skip"],
      );
      for (const check of report.checks) assert.match(check.detail, /capture/);
    } finally {
      db.close();
    }
  });
});

describe("runtime capture gaps", () => {
  for (const version of [0, 2, null]) {
    it(`keeps missing calls visible when a message has unsupported capture version ${version}`, () => {
      const db = fixture();
      try {
        db.exec("UPDATE tool_uses SET outcome = 'denied' WHERE tool_name = 'Write'");
        db.prepare("INSERT INTO messages VALUES ('no-tools', 's1', ?, 0)").run(version);
        const ev = readRunEvidence(db, "x");
        assert.deepEqual(ev.capture, { complete: false, incompleteMessages: 1 });
        const report = auditRuntime(["Read"], ev);
        assert.equal(report.summary.deniedForbidden, 5);
        assert.deepEqual(
          report.checks.map((check) => check.status),
          ["skip", "skip"],
        );
        for (const check of report.checks) assert.match(check.detail, /1.*capture/);
      } finally {
        db.close();
      }
    });
  }

  it("does not treat orphan calls as complete capture or unrelated sessions as relevant", () => {
    const db = fixture();
    try {
      db.exec("INSERT INTO messages VALUES ('other', 's2', 0, NULL)");
      assert.equal(readRunEvidence(db, "x").capture?.complete, true);
      db.exec("DELETE FROM messages WHERE uuid = 'a'");
      assert.deepEqual(readRunEvidence(db, "x").capture, {
        complete: false,
        incompleteMessages: 1,
      });
    } finally {
      db.close();
    }
  });
});

describe("runtime incomplete evidence", () => {
  it("normalizes unsupported and null outcomes to unknown", () => {
    const db = fixture();
    try {
      db.exec(
        "UPDATE tool_uses SET outcome = 'success' WHERE message_uuid = 'a'; UPDATE tool_uses SET outcome = NULL WHERE message_uuid = 'b'",
      );
      assert.deepEqual(
        readRunEvidence(db, "x")
          .actions.slice(0, 2)
          .map((action) => action.outcome),
        ["unknown", "unknown"],
      );
    } finally {
      db.close();
    }
  });

  it("keeps missing tool rows visible even when the capture version claims completeness", () => {
    const db = fixture();
    try {
      db.exec("DELETE FROM tool_uses WHERE message_uuid = 'a'");
      const evidence = readRunEvidence(db, "x");
      assert.deepEqual(evidence.capture, { complete: false, incompleteMessages: 1 });
      assert.equal(auditRuntime(["Read"], evidence).checks[0].status, "skip");
    } finally {
      db.close();
    }
  });

  it("does not blame a skill when an uncaptured message could contain an intervening Skill call", () => {
    const db = fixture();
    try {
      db.exec("INSERT INTO messages VALUES ('gap', 's1', 0, NULL)");
      const report = auditRuntime(["Read"], readRunEvidence(db, "x"));
      assert.equal(report.summary.violations, 1, "the recorded returned result remains visible");
      assert.deepEqual(
        report.checks.map((check) => check.status),
        ["skip", "skip"],
      );
      for (const check of report.checks) assert.match(check.detail, /capture.*inconclusive/);
    } finally {
      db.close();
    }
  });
});
