import assert from "node:assert/strict";
import { it } from "node:test";
import { join } from "node:path";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { getThread, latestSessionId, listThreads, saveThread } from "./threads.js";
import { originFixture, registerWorktree } from "./thread-origin.test-support.js";

it("Windows separators and case identify the same worktree without matching a name prefix", async (t) => {
  const { db, record } = await originFixture(t);
  record("inside", "C:\\Repo\\src", "2026-01-01T00:00:00Z");
  record("outside", "C:\\Repository", "2026-01-02T00:00:00Z");
  assert.equal(latestSessionId(db, { projectPath: "c:/repo" }), "inside");
  saveThread(db, { name: "inside", sessionId: "inside" });
  saveThread(db, { name: "outside", sessionId: "outside" });
  const threads = listThreads(db, { projectPath: "c:/repo" });
  assert.deepEqual(
    threads.map((thread) => thread.name),
    ["inside"],
  );
  assert.equal(threads[0].project_path, "C:\\Repo\\src");
});

it("automatic selection excludes a linked worktree nested inside the current directory", async (t) => {
  const { root, db, record } = await originFixture(t);
  const nested = join(root, "nested-worktree");
  registerWorktree(root, nested, "nested");
  record("current", join(root, "src"), "2026-01-01T00:00:00Z");
  record("nested", join(nested, "src"), "2026-01-02T00:00:00Z");
  assert.equal(latestSessionId(db, { projectPath: root }), "current");
  assert.equal(latestSessionId(db, { projectPath: nested }), "nested");
});

it("native directory aliases match without replacing the recorded spelling", async (t) => {
  const { directory, root, db, record } = await originFixture(t);
  const alias = join(directory, "alias");
  symlinkSync(root, alias, "junction");
  const recorded = join(alias, "future", "src");
  record("aliased", recorded, "2026-01-01T00:00:00Z");
  assert.equal(latestSessionId(db, { projectPath: root }), "aliased");
  saveThread(db, { name: "alias", sessionId: "aliased" });
  assert.equal(getThread(db, "alias")?.project_path, recorded);
  assert.equal(listThreads(db, { projectPath: root })[0]?.name, "alias");
  assert.equal(listThreads(db, { projectPath: alias })[0]?.name, "alias");
});

it("a shared project identity does not widen automatic selection to another clone", async (t) => {
  const { directory, root, db, record } = await originFixture(t);
  const clone = join(directory, "clone");
  mkdirSync(clone);
  const config = '[memory]\nproject_id = "00000000-0000-4000-8000-000000000001"\n';
  writeFileSync(join(root, ".kit.toml"), config);
  writeFileSync(join(clone, ".kit.toml"), config);
  record("local", root, "2026-01-01T00:00:00Z");
  record("other-clone", clone, "2026-01-02T00:00:00Z");
  assert.equal(latestSessionId(db, { projectPath: root }), "local");
});
