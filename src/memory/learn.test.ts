import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { openMemoryDb, insertMessage } from "./db.js";
import { learnRecurring, normalizeInstruction, isBoilerplate } from "./learn.js";

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

  it("isBoilerplate flags harness scaffolding but not real instructions", () => {
    // scaffolding — filtered
    assert.equal(isBoilerplate("<system-reminder>do X</system-reminder>"), true);
    assert.equal(isBoilerplate("  <local-command-caveat> ... "), true);
    assert.equal(isBoilerplate("/model claude-sonnet"), true);
    assert.equal(isBoilerplate("/clear"), true);
    assert.equal(isBoilerplate("Continue from where you left off"), true);
    assert.equal(
      isBoilerplate("This session is being continued from a previous conversation. Summary:"),
      true,
    );
    assert.equal(isBoilerplate("   "), true);
    assert.equal(isBoilerplate("Stop hook feedback: [~/.claude/x.sh]: uncommitted changes"), true);
    assert.equal(isBoilerplate("UserPromptSubmit hook success: You have local memory…"), true);
    assert.equal(
      isBoilerplate("[Image: original 2560x2000. Multiply coordinates by 1.28 …]"),
      true,
    );
    // real instructions — kept
    assert.equal(isBoilerplate("always run the tests before pushing"), false);
    assert.equal(isBoilerplate("/etc/hosts is wrong, fix the resolver"), false); // path, not a command
    assert.equal(isBoilerplate("no, use the wrapper instead"), false);
  });

  it("excludes harness scaffolding from candidates even when it recurs 3×+", () => {
    const db = fresh();
    // scaffolding repeated across sessions — must NOT surface
    seed(db, "s1a", "s1", "<system-reminder>reindex the store</system-reminder>");
    seed(db, "s1b", "s2", "<system-reminder>reindex the store</system-reminder>");
    seed(db, "s1c", "s3", "<system-reminder>reindex the store</system-reminder>");
    seed(db, "m1", "s1", "/model claude-sonnet");
    seed(db, "m2", "s2", "/model claude-sonnet");
    seed(db, "m3", "s3", "/model claude-sonnet");
    seed(db, "k1", "s1", "Continue from where you left off");
    seed(db, "k2", "s2", "Continue from where you left off");
    seed(db, "k3", "s3", "Continue from where you left off");
    // a genuine recurring instruction alongside the noise — must be the only candidate
    seed(db, "r1", "s1", "prefer the self-healing wrapper for hooks");
    seed(db, "r2", "s2", "prefer the self-healing wrapper for hooks");
    seed(db, "r3", "s3", "prefer the self-healing wrapper for hooks");
    const cands = learnRecurring(db);
    assert.equal(cands.length, 1, "scaffolding filtered, only the real instruction remains");
    assert.match(cands[0]?.example ?? "", /self-healing wrapper/i);
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
