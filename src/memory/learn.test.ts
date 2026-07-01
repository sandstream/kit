import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { openMemoryDb, insertMessage } from "./db.js";
import { learnRecurring, normalizeInstruction } from "./learn.js";

describe("memory learn — recurring instruction mining", () => {
  const fresh = () => openMemoryDb(":memory:");
  const seed = (db: DatabaseSync, uuid: string, sessionId: string, content: string) =>
    insertMessage(db, { uuid, sessionId, type: "user", role: "user", content });

  it("normalizeInstruction lowercases, strips punctuation, collapses whitespace", () => {
    assert.equal(normalizeInstruction("  Always use ÅÖÄ!! "), "always use åöä");
    assert.equal(normalizeInstruction("No, don't do that."), "no don t do that");
  });

  it("surfaces a message repeated 3× across sessions; ignores one-offs + short chatter", () => {
    const db = fresh();
    seed(db, "a1", "s1", "always keep code quality high");
    seed(db, "a2", "s2", "Always keep code quality high.");
    seed(db, "a3", "s3", "always keep  code quality high");
    seed(db, "b1", "s1", "a unique one-off request about pricing tiers");
    seed(db, "c1", "s1", "ok"); // < 3 words — skipped
    seed(db, "c2", "s2", "yes please"); // < 3 words — skipped
    const cands = learnRecurring(db);
    assert.equal(cands.length, 1);
    assert.equal(cands[0]?.count, 3);
    assert.equal(cands[0]?.sessions, 3);
    assert.match(cands[0]?.example ?? "", /keep code quality high/i);
    assert.equal(cands[0]?.correction, false);
    db.close();
  });

  it("flags a repeated correction and ranks cross-session above a single-session nag", () => {
    const db = fresh();
    // correction, 3× across 3 sessions
    seed(db, "x1", "s1", "no stop doing that");
    seed(db, "x2", "s2", "No, stop doing that.");
    seed(db, "x3", "s3", "no stop doing that");
    // non-correction, 4× but all in ONE session (a nagging loop)
    seed(db, "y1", "s9", "please add the export line");
    seed(db, "y2", "s9", "please add the export line");
    seed(db, "y3", "s9", "please add the export line");
    seed(db, "y4", "s9", "please add the export line");
    const cands = learnRecurring(db);
    assert.equal(cands.length, 2);
    // cross-session (3) ranks above single-session (1) even though its raw count is lower
    assert.equal(cands[0]?.sessions, 3);
    assert.equal(cands[0]?.correction, true);
    assert.equal(cands[1]?.sessions, 1);
    assert.equal(cands[1]?.count, 4);
    db.close();
  });

  it("respects minCount / minSessions thresholds", () => {
    const db = fresh();
    seed(db, "a1", "s1", "twice only instruction here");
    seed(db, "a2", "s2", "twice only instruction here");
    assert.equal(learnRecurring(db).length, 0); // default minCount=3 → below threshold
    assert.equal(learnRecurring(db, { minCount: 2 }).length, 1); // lowered → surfaces
    assert.equal(learnRecurring(db, { minCount: 2, minSessions: 3 }).length, 0); // needs 3 sessions
    db.close();
  });
});
