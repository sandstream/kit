import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemoryDb, upsertSession, insertMessage } from "./db.js";
import { userPromptSubmitReminder, sessionStartRecovery, dueForHarnessSweep } from "./hook.js";
import { getCurrentProjectRoot } from "./project.js";

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

describe("memory hook — SessionStart recovery", () => {
  let tmp: string;
  const prev = process.env.KIT_MEMORY_DB;

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "kit-recover-"));
    process.env.KIT_MEMORY_DB = join(tmp, "memory.db");
  });

  after(() => {
    if (prev === undefined) delete process.env.KIT_MEMORY_DB;
    else process.env.KIT_MEMORY_DB = prev;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns empty when there is nothing to recover (fail-open)", () => {
    assert.equal(sessionStartRecovery(), "");
  });

  it("re-injects this project's recent messages newest-first with a search hint", () => {
    const root = getCurrentProjectRoot();
    const db = openMemoryDb();
    upsertSession(db, { sessionId: "r1", harness: "claude-code" });
    insertMessage(db, {
      uuid: "r-old",
      sessionId: "r1",
      type: "user",
      content: "older note",
      cwd: root,
      timestamp: "2026-01-01T10:00:00Z",
    });
    insertMessage(db, {
      uuid: "r-new",
      sessionId: "r1",
      type: "assistant",
      role: "assistant",
      content: "latest decision",
      cwd: root,
      timestamp: "2026-01-02T10:00:00Z",
    });
    db.close();

    const text = sessionStartRecovery();
    assert.match(text, /Picking up in/);
    assert.match(text, /latest decision/);
    assert.match(text, /kit memory search/);
    // newest-first ordering: the latest message precedes the older one
    assert.ok(text.indexOf("latest decision") < text.indexOf("older note"));
  });
});

describe("memory hook — harness sweep debounce", () => {
  let tmp: string;
  const prevDir = process.env.KIT_MEMORY_DIR;

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "kit-sweep-"));
    process.env.KIT_MEMORY_DIR = tmp;
  });

  after(() => {
    if (prevDir === undefined) delete process.env.KIT_MEMORY_DIR;
    else process.env.KIT_MEMORY_DIR = prevDir;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("is due when no sweep marker exists yet", () => {
    assert.equal(dueForHarnessSweep(), true);
  });

  it("is not due right after a sweep, but due once the 6h interval elapses", () => {
    const marker = join(tmp, ".harness-sweep");
    writeFileSync(marker, new Date().toISOString());
    const mtime = statSync(marker).mtimeMs;
    assert.equal(dueForHarnessSweep(mtime + 60_000), false, "1 min later → not due");
    assert.equal(dueForHarnessSweep(mtime + 7 * 60 * 60 * 1000), true, "7h later → due");
  });
});
