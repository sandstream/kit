import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectAgentSession, ungatedSessionDetail } from "./agent-session.js";

describe("detectAgentSession", () => {
  it("reads Claude Code from CLAUDECODE=1 only", () => {
    assert.strictEqual(detectAgentSession({ CLAUDECODE: "1" }), "Claude Code");
    assert.strictEqual(detectAgentSession({ CLAUDECODE: "0" }), undefined);
    assert.strictEqual(detectAgentSession({ CLAUDECODE: "" }), undefined);
  });

  it("reads Codex from CODEX_THREAD_ID, before an inherited CLAUDECODE", () => {
    assert.strictEqual(detectAgentSession({ CODEX_THREAD_ID: "t-1" }), "Codex");
    assert.strictEqual(detectAgentSession({ CODEX_THREAD_ID: "t-1", CLAUDECODE: "1" }), "Codex");
    assert.strictEqual(detectAgentSession({ CODEX_THREAD_ID: "  " }), undefined);
  });

  it("ignores variables that do not mark an interactive session", () => {
    assert.strictEqual(detectAgentSession({}), undefined);
    assert.strictEqual(detectAgentSession({ CODEX_CI: "1", CODEX_SANDBOX: "x" }), undefined);
    assert.strictEqual(detectAgentSession({ AI_AGENT: "claude" }), undefined);
  });
});

describe("ungatedSessionDetail", () => {
  it("names the session and the fix in a kit-managed checkout", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-agent-session-"));
    try {
      writeFileSync(join(dir, ".kit.toml"), "");
      const detail = ungatedSessionDetail(dir, { CLAUDECODE: "1" });
      assert.match(detail ?? "", /^a Claude Code session is running/);
      assert.match(detail ?? "", /Run: kit agent-config$/);
      assert.match(ungatedSessionDetail(dir, { CODEX_THREAD_ID: "t" }) ?? "", /^a Codex session/);
      assert.strictEqual(ungatedSessionDetail(dir, {}), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is undefined without .kit.toml, even in a session", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-agent-session-"));
    try {
      assert.strictEqual(ungatedSessionDetail(dir, { CLAUDECODE: "1" }), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
