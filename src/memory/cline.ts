/**
 * kit memory — Cline transcript parser (multi-harness).
 *
 * Cline (VS Code extension `saoudrizwan.claude-dev`) stores each task under
 * globalStorage/saoudrizwan.claude-dev/tasks/<taskId>/, with the conversation in
 * api_conversation_history.json — an array of Anthropic-format messages:
 *
 *   [{ role: "user"|"assistant", content: string | [{ type:"text", text }, …] }]
 *
 * (verified against cline/cline + community readers). This is the same message
 * shape kit already parses for Claude Code, so extraction is clean. We index
 * user/assistant text turns, tag harness="cline", synthesize stable uuids.
 * Idempotent, incremental, fail-safe, no model calls.
 *
 * Default path targets stable VS Code; point KIT_CLINE_DIR at the
 * saoudrizwan.claude-dev dir for Cursor/Insiders/VSCodium installs.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { insertMessage, upsertSession, isFileIndexed, markFileIndexed } from "./db.js";
import type { IndexResult } from "./parser.js";

function vscodeGlobalStorage(): string {
  const home = homedir();
  switch (process.platform) {
    case "darwin":
      return join(home, "Library", "Application Support", "Code", "User", "globalStorage");
    case "win32":
      return join(
        process.env.APPDATA ?? join(home, "AppData", "Roaming"),
        "Code",
        "User",
        "globalStorage",
      );
    default:
      return join(home, ".config", "Code", "User", "globalStorage");
  }
}

export function getClineTasksDir(): string {
  const base = process.env.KIT_CLINE_DIR ?? join(vscodeGlobalStorage(), "saoudrizwan.claude-dev");
  return join(base, "tasks");
}

interface AnthropicBlock {
  type?: string;
  text?: string;
}
interface ClineMessage {
  role?: string;
  content?: string | AnthropicBlock[];
}

/** Flatten Anthropic content (string | block[]) to plain text. */
function textOf(content: string | AnthropicBlock[] | undefined): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b?.type === "text" ? (b.text ?? "") : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function indexTask(db: DatabaseSync, taskId: string, filepath: string): { messages: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filepath, "utf8"));
  } catch {
    return { messages: 0 };
  }
  if (!Array.isArray(parsed)) return { messages: 0 };

  const sessionId = `cline:${taskId}`;
  upsertSession(db, { sessionId, harness: "cline" });
  let messages = 0;
  (parsed as ClineMessage[]).forEach((msg, idx) => {
    if (msg?.role !== "user" && msg?.role !== "assistant") return;
    const text = textOf(msg.content).trim();
    if (!text) return; // tool-only / image-only turns carry no searchable text
    const added = insertMessage(db, {
      uuid: `cline:${taskId}:${idx}`,
      sessionId,
      type: msg.role,
      role: msg.role,
      content: text,
    });
    if (added) messages++;
  });
  return { messages };
}

/** Walk Cline's tasks dir and index every api_conversation_history.json. Idempotent + incremental. */
export function indexClineSessions(db: DatabaseSync): IndexResult {
  const result: IndexResult = { files: 0, sessions: 0, messages: 0, toolUses: 0, filesSkipped: 0 };
  const tasksDir = getClineTasksDir();
  if (!existsSync(tasksDir)) return result;

  let taskDirs;
  try {
    taskDirs = readdirSync(tasksDir, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of taskDirs) {
    if (!entry.isDirectory()) continue;
    const filepath = join(tasksDir, entry.name, "api_conversation_history.json");
    let st;
    try {
      st = statSync(filepath);
    } catch {
      continue; // task without a conversation file → skip
    }
    const mtimeMs = Math.floor(st.mtimeMs);
    if (isFileIndexed(db, filepath, mtimeMs, st.size)) {
      result.filesSkipped++;
      continue;
    }
    const counts = indexTask(db, entry.name, filepath);
    markFileIndexed(db, filepath, mtimeMs, st.size);
    result.files++;
    result.sessions++;
    result.messages += counts.messages;
  }
  return result;
}
