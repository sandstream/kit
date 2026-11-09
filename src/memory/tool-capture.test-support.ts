import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemoryDb } from "./db.js";
import { indexCodexSessions } from "./codex.js";
import { indexClaudeTranscripts } from "./parser.js";
import { rmTemp } from "../temp-cleanup.test-support.js";

export function fixture(
  t: import("node:test").TestContext,
  harness: "codex" | "claude",
  records: unknown[],
) {
  const dir = mkdtempSync(join(tmpdir(), "kit-tool-capture-"));
  const sub = harness === "codex" ? "sessions" : "projects/demo";
  mkdirSync(join(dir, sub), { recursive: true });
  const file = join(dir, sub, harness === "codex" ? "rollout-s.jsonl" : "s.jsonl");
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const key = harness === "codex" ? "KIT_CODEX_DIR" : "KIT_CLAUDE_DIR";
  const previous = process.env[key];
  process.env[key] = dir;
  const db = openMemoryDb(":memory:");
  t.after(() => {
    db.close();
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
    rmTemp(dir);
  });
  return {
    db,
    file,
    index: () => (harness === "codex" ? indexCodexSessions(db) : indexClaudeTranscripts(db)),
  };
}
export const meta = { type: "session_meta", payload: { id: "s", cwd: "/demo" } };
export const codex = (payload: unknown) => ({
  type: "response_item",
  timestamp: "2026-01-01T00:00:00Z",
  payload,
});
export const turn = (text: string) =>
  codex({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
export const call = (id = "c") =>
  codex({ type: "function_call", call_id: id, name: "exec_command", arguments: '{"cmd":"pwd"}' });
export const result = (id = "c") =>
  codex({ type: "function_call_output", call_id: id, output: "reported response" });
