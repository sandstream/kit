import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemoryDb, upsertSession, insertMessage } from "./db.js";
import { userPromptSubmitReminder } from "./hook.js";

describe("memory hook — UserPromptSubmit reminder", () => {
  let tmp: string;
  const prev = process.env.KIT_MEMORY_DB;

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "kit-hook-"));
    process.env.KIT_MEMORY_DB = join(tmp, "memory.db");
    const db = openMemoryDb();
    upsertSession(db, { sessionId: "s1", harness: "claude-code" });
    insertMessage(db, { uuid: "u1", sessionId: "s1", type: "user", content: "hi" });
    db.close();
  });

  after(() => {
    if (prev === undefined) delete process.env.KIT_MEMORY_DB;
    else process.env.KIT_MEMORY_DB = prev;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("nudges the agent to search and reports the message count", () => {
    const text = userPromptSubmitReminder();
    assert.match(text, /kit memory search/);
    assert.match(text, /1 messages/);
  });

  it("never throws (fail-open)", () => {
    assert.doesNotThrow(() => userPromptSubmitReminder());
  });
});
