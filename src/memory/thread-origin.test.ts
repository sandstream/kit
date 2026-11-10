import assert from "node:assert/strict";
import { it } from "node:test";
import { join } from "node:path";
import { insertMessage, openMemoryDb, upsertSession } from "./db.js";
import { syncFromExport } from "./sync.js";
import {
  getThread,
  latestSessionId,
  listThreads,
  saveThread,
  type SavedThread,
} from "./threads.js";
import { originFixture } from "./thread-origin.test-support.js";

it("automatic save selects this worktree while the list still includes its sibling", async (t) => {
  const { root, sibling, db, memory, record } = await originFixture(t);
  record("main-claude", root, "2026-01-01T00:00:00Z", "claude-code");
  record("review-codex", sibling, "2026-01-02T00:00:00Z");
  assert.equal(latestSessionId(db, { projectPath: root }), "main-claude");
  await memory(sibling, "save", "review");
  await memory(root, "save", "main");
  const listed: SavedThread[] = JSON.parse(await memory(root, "threads", "--json"));
  assert.deepEqual(listed.map((thread) => thread.name).sort(), ["main", "review"]);
  assert.equal(listed.find((thread) => thread.name === "main")?.session_id, "main-claude");
  const resumed = await memory(root, "resume", "main");
  assert.ok(resumed.includes(`Recorded worktree: ${root}`));
  assert.match(resumed, /claude --resume main-claude/);
  assert.doesNotMatch(resumed, /codex resume/);
});

it("explicit session save retains its recorded origin and stays listed from the caller", async (t) => {
  const { root, sibling, db, memory, record } = await originFixture(t);
  record("foreign-session", sibling, "2026-01-01T00:00:00Z");
  await memory(root, "save", "chosen", "--session=foreign-session");
  assert.equal(getThread(db, "chosen")?.project_path, sibling);
  const listed: SavedThread[] = JSON.parse(await memory(root, "threads", "--json"));
  const index = listed.findIndex((thread) => thread.name === "chosen");
  assert.notEqual(index, -1);
  const resumed = await memory(root, "resume", String(index + 1));
  assert.ok(resumed.includes(`Recorded worktree: ${sibling}`));
  assert.match(resumed, /codex resume foreign-session/);
});

it("replacing a bookmark with a session without recorded cwd clears the old origin", async (t) => {
  const { root, sibling, db, memory, record } = await originFixture(t);
  record("known", sibling, "2026-01-01T00:00:00Z");
  record("unknown", undefined, "2026-01-02T00:00:00Z", "claude-code");
  await memory(root, "save", "handoff", "--session=known");
  await memory(root, "save", "handoff", "--session=unknown");
  assert.equal(getThread(db, "handoff")?.project_path, null);
  const listed: SavedThread[] = JSON.parse(await memory(root, "threads", "--json"));
  assert.equal(listed.find((thread) => thread.name === "handoff")?.session_id, "unknown");
  const resumed = await memory(root, "resume", "handoff");
  assert.match(resumed, /^Recorded worktree: unknown$/m);
  assert.match(resumed, /claude --resume unknown/);
});

it("a saved imported session retains raw origin and local recall scope", async (t) => {
  const { directory, root, db, memory } = await originFixture(t);
  const sourcePath = join(directory, "sender.db");
  const sender = openMemoryDb(sourcePath);
  const origin = "C:\\agent\\checkout";
  try {
    upsertSession(sender, { sessionId: "imported", harness: "codex" });
    insertMessage(sender, {
      uuid: "imported-message",
      sessionId: "imported",
      type: "assistant",
      content: "Synthetic imported history",
      cwd: origin,
      timestamp: "2026-01-01T00:00:00Z",
    });
  } finally {
    sender.close();
  }
  syncFromExport(db, sourcePath, { projectMappings: [{ from: origin, to: root }] });
  saveThread(db, { name: "imported-copy", sessionId: "imported" });
  assert.equal(getThread(db, "imported-copy")?.project_path, origin);
  assert.equal(listThreads(db, { projectPath: root })[0]?.name, "imported-copy");
  await memory(root, "save", "automatic-import");
  await memory(root, "save", "explicit-import", "--session=imported");
  for (const name of ["automatic-import", "explicit-import"]) {
    assert.equal(getThread(db, name)?.project_path, origin);
    const resumed = await memory(root, "resume", name);
    assert.ok(resumed.includes(`Recorded worktree: ${origin}`));
    assert.match(resumed, /availability is not checked/);
  }
});

it("automatic save keeps the selected worktree's recorded cwd when a session touches both", async (t) => {
  const { root, sibling, db, memory, record } = await originFixture(t);
  const recorded = join(root, "src");
  record("shared-session", recorded, "2026-01-01T00:00:00Z");
  record("shared-session", sibling, "2026-01-02T00:00:00Z");
  await memory(root, "save", "selected-origin");
  assert.equal(getThread(db, "selected-origin")?.project_path, recorded);
  const resumed = await memory(root, "resume", "1");
  assert.ok(resumed.includes(`Recorded worktree: ${recorded}`));
});

it("explicit --session accepts a separate value without changing the bookmark name", async (t) => {
  const { root, sibling, db, memory, record } = await originFixture(t);
  record("chosen-session", sibling, "2026-01-01T00:00:00Z");
  await memory(root, "save", "chosen name", "--session", "chosen-session");
  assert.equal(getThread(db, "chosen name")?.project_path, sibling);
  assert.match(await memory(root, "resume", "chosen name"), /codex resume chosen-session/);
});

it("automatic save refuses a sibling-only history and explicit unknown origin remains honest", async (t) => {
  const { root, sibling, db, memory, record } = await originFixture(t);
  record("sibling-only", sibling, "2026-01-01T00:00:00Z");
  assert.equal(latestSessionId(db, { projectPath: root }), undefined);
  await assert.rejects(memory(root, "save", "automatic"), /no session found/);
  assert.equal(getThread(db, "automatic"), undefined);
  await memory(root, "save", "unknown", "--session=unindexed");
  const listed: SavedThread[] = JSON.parse(await memory(root, "threads", "--json"));
  assert.equal(listed[0].project_path, null);
  assert.equal(listed[0].harness, null);
  assert.match(await memory(root, "resume", "1"), /^Recorded worktree: unknown$/m);
});

it("save rejects missing --session values without replacing an existing bookmark", async (t) => {
  const { root, sibling, memory, record } = await originFixture(t);
  record("kept-session", sibling, "2026-01-01T00:00:00Z");
  record("chosen-session", sibling, "2026-01-02T00:00:00Z");
  record("local-newer", root, "2026-01-03T00:00:00Z");
  await memory(root, "save", "preserved name", "--session=kept-session");
  const before: SavedThread[] = JSON.parse(await memory(root, "threads", "--json"));
  assert.equal(before[0].session_id, "kept-session");

  for (const args of [
    ["--session"],
    ["--session="],
    ["--session", ""],
    ["--session", "  "],
    ["--session", "--json"],
  ]) {
    await assert.rejects(
      memory(root, "save", "preserved name", ...args),
      /--session requires a non-empty session id/,
    );
    assert.deepEqual(JSON.parse(await memory(root, "threads", "--json")), before);
  }

  await memory(root, "save", "preserved name", "--session", "chosen-session");
  const after: SavedThread[] = JSON.parse(await memory(root, "threads", "--json"));
  assert.equal(after.length, 1);
  assert.equal(after[0].name, "preserved name");
  assert.equal(after[0].session_id, "chosen-session");
  assert.equal(after[0].project_path, sibling);
  assert.match(await memory(root, "resume", "preserved name"), /codex resume chosen-session/);
});
