import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { metadataFixture, MODES, APIS } from "./metadata-import.test-support.js";
import { indexClaudeTranscripts } from "./parser.js";
import { indexCodexSessions } from "./codex.js";
import { readRunEvidence } from "../skill/attribute.js";
import { auditRuntime } from "../skill/adherence.js";
import { scanToolUsage } from "../insight/usage-scan.js";

const claudeCall = (uuid: string, name: string, input: unknown) => ({
  type: "assistant",
  uuid,
  sessionId: "claude-session",
  timestamp: `2026-01-01T00:00:0${uuid.at(-1)}Z`,
  message: { content: [{ type: "tool_use", id: uuid, name, input }] },
});
const claudeResult = (uuid: string, call: string, error = false) => ({
  type: "user",
  uuid,
  sessionId: "claude-session",
  message: {
    content: [
      { type: "tool_result", tool_use_id: call, is_error: error, content: "reported response" },
    ],
  },
});
const lines = (records: unknown[]) =>
  records.map((record) => JSON.stringify(record)).join("\n") + "\n";

for (const mode of MODES)
  for (const api of APIS) {
    it(`native capture reaches sync and runtime reports with late outcomes (${mode}, ${api})`, (t) => {
      const f = metadataFixture(t);
      const previous = [process.env.KIT_CLAUDE_DIR, process.env.KIT_CODEX_DIR];
      process.env.KIT_CLAUDE_DIR = join(f.root, "claude");
      process.env.KIT_CODEX_DIR = join(f.root, "codex");
      t.after(() => {
        for (const [i, key] of ["KIT_CLAUDE_DIR", "KIT_CODEX_DIR"].entries()) {
          if (previous[i] === undefined) delete process.env[key];
          else process.env[key] = previous[i];
        }
      });
      const project = join(f.root, "claude", "projects", "demo");
      const rollouts = join(f.root, "codex", "sessions");
      mkdirSync(project, { recursive: true });
      mkdirSync(rollouts, { recursive: true });
      const transcript = join(project, "claude-session.jsonl");
      const records = [
        claudeCall("call0", "Skill", { skill: "demo" }),
        claudeResult("result0", "call0"),
        claudeCall("call1", "Read", { file: "guide" }),
        claudeResult("result1", "call1"),
        claudeCall("call2", "Write", { file: "other" }),
      ];
      writeFileSync(transcript, lines(records));
      writeFileSync(
        join(rollouts, "rollout-codex-session.jsonl"),
        lines([
          { type: "session_meta", payload: { id: "codex-session", cwd: f.root } },
          {
            type: "response_item",
            payload: {
              type: "function_call",
              call_id: "remote-call",
              name: "mcp__demo__read",
              arguments: "{}",
            },
          },
          {
            type: "response_item",
            payload: {
              type: "function_call_output",
              call_id: "remote-call",
              output: "reported response",
            },
          },
        ]),
      );
      const exportCurrent = () =>
        f.exportMemory(mode, "archive", (db) => {
          indexClaudeTranscripts(db);
          indexCodexSessions(db);
        }).path;
      const target = f.target();
      f.importMemory(target, exportCurrent(), api);
      let evidence = readRunEvidence(target, "demo");
      assert.equal(evidence.runs, 1);
      assert.deepEqual(
        evidence.actions.map((action) => action.outcome),
        ["returned", "unknown"],
      );
      assert.equal(auditRuntime(["Read"], evidence).checks[0].status, "skip");
      assert.equal(scanToolUsage(target).find((tool) => tool.tool === "mcp__demo__read")?.count, 1);
      writeFileSync(transcript, lines([...records, claudeResult("result2", "call2")]));
      const later = exportCurrent();
      f.importMemory(target, later, api);
      f.importMemory(target, later, api);
      evidence = readRunEvidence(target, "demo");
      assert.deepEqual(
        evidence.actions.map((action) => action.outcome),
        ["returned", "returned"],
      );
      assert.equal(auditRuntime(["Read"], evidence).checks[0].status, "fail");
      assert.equal(target.prepare("SELECT COUNT(*) n FROM tool_uses").get()?.n, 4);
    });
  }
