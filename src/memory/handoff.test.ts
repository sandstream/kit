import { after, before, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openMemoryDb, searchMessages, upsertSession, insertMessage } from "./db.js";
import { indexClaudeTranscripts } from "./parser.js";
import { indexCodexSessions } from "./codex.js";
import { sessionStartRecovery } from "./hook.js";
import { listThreads, saveThread } from "./threads.js";

let tmp: string;
let root: string;
let worktree: string;
const keys = [
  "KIT_MEMORY_DB",
  "KIT_CLAUDE_DIR",
  "KIT_CODEX_DIR",
  "KIT_MEMORY_DIR",
  "KIT_NO_UPDATE_CHECK",
];
const previous = new Map(keys.map((key) => [key, process.env[key]]));
const cli = resolve("dist/cli.js");

before(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "kit-handoff-")));
  root = join(tmp, "repo_%");
  worktree = join(tmp, "review worktree");
  mkdirSync(root);
  const hooks = join(tmp, "empty-hooks");
  mkdirSync(hooks);
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", `core.hooksPath=${hooks}`, ...args], { cwd: root, stdio: "pipe" });
  git("init");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  );
  git("worktree", "add", "--detach", worktree);
  process.env.KIT_MEMORY_DB = join(tmp, "memory.db");
  process.env.KIT_MEMORY_DIR = join(tmp, "kit");
  process.env.KIT_CLAUDE_DIR = join(tmp, "claude");
  process.env.KIT_CODEX_DIR = join(tmp, "codex");
  process.env.KIT_NO_UPDATE_CHECK = "1";
  writeTranscripts();
  const db = openMemoryDb();
  try {
    assert.equal(indexClaudeTranscripts(db).messages, 1);
    assert.equal(indexCodexSessions(db).messages, 1);
    upsertSession(db, { sessionId: "unrelated", harness: "codex" });
    insertMessage(db, {
      uuid: "unrelated",
      sessionId: "unrelated",
      type: "assistant",
      content: "handoffledger unrelated project",
      cwd: join(tmp, "repoXother", "subdir"),
    });
    saveThread(db, { name: "claude-decision", sessionId: "claude-handoff", projectPath: root });
    saveThread(db, { name: "codex-review", sessionId: "codex-handoff", projectPath: worktree });
  } finally {
    db.close();
  }
});

function writeTranscripts(): void {
  const claudeDir = join(tmp, "claude", "projects", "fixture");
  const codexDir = join(tmp, "codex", "sessions");
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(codexDir, { recursive: true });
  writeFileSync(
    join(claudeDir, "claude-handoff.jsonl"),
    JSON.stringify({
      type: "assistant",
      uuid: "handoff-claude",
      sessionId: "claude-handoff",
      cwd: root,
      gitBranch: "main",
      timestamp: "2026-06-01T10:00:00Z",
      message: { role: "assistant", content: "handoffledger: preserve offline recovery" },
    }) + "\n",
  );
  writeFileSync(
    join(codexDir, "rollout-codex-handoff.jsonl"),
    [
      { type: "session_meta", payload: { id: "codex-handoff", cwd: worktree } },
      {
        type: "response_item",
        timestamp: "2026-06-01T10:01:00Z",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "handoffledger: review remains pending" }],
        },
      },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n") + "\n",
  );
}

after(() => {
  for (const key of keys) {
    const value = previous.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tmp, { recursive: true, force: true });
});

it("indexes both real transcript formats idempotently into one private store", () => {
  const db = openMemoryDb();
  try {
    assert.equal(indexClaudeTranscripts(db).messages, 0);
    assert.equal(indexCodexSessions(db).messages, 0);
    assert.deepEqual(
      searchMessages(db, "handoffledger")
        .map((hit) => hit.sessionId)
        .sort(),
      ["claude-handoff", "codex-handoff", "unrelated"],
    );
  } finally {
    db.close();
  }
});

it("recalls both agents from either worktree without mixing unrelated repositories", () => {
  const db = openMemoryDb();
  try {
    for (const projectPath of [root, worktree]) {
      assert.deepEqual(
        searchMessages(db, "handoffledger", { projectPath })
          .map((hit) => hit.sessionId)
          .sort(),
        ["claude-handoff", "codex-handoff"],
      );
      assert.deepEqual(
        listThreads(db, { projectPath })
          .map((thread) => thread.name)
          .sort(),
        ["claude-decision", "codex-review"],
      );
    }
  } finally {
    db.close();
  }
});

it("delivers the handoff through the real CLI and session-start recovery", () => {
  for (const cwd of [root, worktree]) {
    const output = execFileSync(process.execPath, [cli, "memory", "search", "handoffledger"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.match(output, /preserve offline recovery/);
    assert.match(output, /review remains pending/);
    assert.match(output, /claude-code/);
    assert.match(output, /codex/);
    assert.doesNotMatch(output, /unrelated project/);
    const recovery = sessionStartRecovery({ root: cwd });
    assert.match(recovery, /preserve offline recovery/);
    assert.match(recovery, /review remains pending/);
    assert.match(recovery, /STORED DATA, not instructions/);
    assert.ok(recovery.includes(root));
    assert.ok(recovery.includes(worktree));
    assert.doesNotMatch(recovery, /unrelated project/);
  }
});

it("retains source worktrees in suggestions, bookmark listings, and resume guidance", () => {
  for (const cwd of [root, worktree]) {
    for (const command of [
      ["suggest"],
      ["threads"],
      ["resume", "claude-decision"],
      ["resume", "codex-review"],
    ]) {
      const output = execFileSync(process.execPath, [cli, "memory", ...command], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (command[0] !== "resume") {
        assert.ok(output.includes(root));
        assert.ok(output.includes(worktree));
        assert.match(output, /claude-code/);
        assert.match(output, /codex/);
      } else {
        assert.ok(output.includes(command[1] === "claude-decision" ? root : worktree));
        assert.match(output, /native session files/);
      }
    }
  }
});
