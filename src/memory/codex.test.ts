import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemoryDb, getStats, searchMessages } from "./db.js";
import { indexCodexSessions } from "./codex.js";

describe("memory codex parser", () => {
  let tmp: string;
  const prev = process.env.KIT_CODEX_DIR;

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "kit-codex-"));
    const dir = join(tmp, "sessions", "2026", "03", "31");
    mkdirSync(dir, { recursive: true });
    const lines = [
      JSON.stringify({
        timestamp: "2026-03-31T11:04:42Z",
        type: "session_meta",
        payload: { id: "sess-xyz", cwd: "/Users/me/dev/demo", model_provider: "openai" },
      }),
      JSON.stringify({
        timestamp: "2026-03-31T11:05:00Z",
        type: "response_item",
        payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "system permissions noise" }] },
      }),
      JSON.stringify({
        timestamp: "2026-03-31T11:05:10Z",
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "october pricing question" }] },
      }),
      JSON.stringify({
        timestamp: "2026-03-31T11:05:20Z",
        type: "event_msg",
        payload: { type: "agent_message", message: "duplicate of the response_item" },
      }),
      JSON.stringify({
        timestamp: "2026-03-31T11:05:21Z",
        type: "response_item",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "here is the answer" }] },
      }),
    ].join("\n");
    writeFileSync(join(dir, "rollout-2026-03-31T11-04-40-sess-xyz.jsonl"), lines);
    process.env.KIT_CODEX_DIR = tmp;
  });

  after(() => {
    if (prev === undefined) delete process.env.KIT_CODEX_DIR;
    else process.env.KIT_CODEX_DIR = prev;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("indexes user + assistant turns, skips developer/event_msg, tags harness=codex", () => {
    const db = openMemoryDb(":memory:");
    const res = indexCodexSessions(db);
    assert.equal(res.messages, 2); // user + assistant; developer + event_msg skipped
    assert.equal(getStats(db).messages, 2);
    const session = db
      .prepare("SELECT harness FROM sessions WHERE session_id = 'sess-xyz'")
      .get() as { harness: string } | undefined;
    assert.equal(session?.harness, "codex");
    assert.equal(searchMessages(db, "october").length, 1);
    db.close();
  });

  it("is incremental + idempotent — re-index skips the unchanged rollout", () => {
    const db = openMemoryDb(":memory:");
    indexCodexSessions(db);
    const second = indexCodexSessions(db);
    assert.equal(second.messages, 0);
    assert.equal(second.filesSkipped, 1);
    db.close();
  });
});
