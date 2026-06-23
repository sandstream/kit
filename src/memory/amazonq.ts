/**
 * kit memory — Amazon Q Developer CLI transcript parser (multi-harness).
 *
 * The `q chat` CLI persists conversations in a SQLite DB at
 * <data_local_dir>/amazon-q/data.sqlite3 (paths + schema verified against the
 * aws/amazon-q-developer-cli source). Table `conversations (key TEXT PRIMARY
 * KEY, value TEXT)`: `key` is the working-directory path the chat ran in,
 * `value` is a JSON-serialized ConversationState:
 *
 *   { history: [{ user: UserMessage, assistant: AssistantMessage, ... }],
 *     transcript: [String] }
 *
 * We index the structured `history` user/assistant turns (project-scoped via the
 * key path), tag harness="amazon-q", and synthesize stable uuids. The inner
 * message-content shape is extracted DEFENSIVELY (string | {content|text|prompt}
 * | array) so an enum/wrapper variant degrades to "no text" rather than wrong
 * text. Read-only, idempotent, fail-safe, no model calls.
 */
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { insertMessage, upsertSession, isFileIndexed, markFileIndexed } from "./db.js";
import type { IndexResult } from "./parser.js";

/** Mirror of Rust `dirs::data_local_dir()` per platform. */
function dataLocalDir(): string {
  const home = homedir();
  switch (process.platform) {
    case "darwin":
      return join(home, "Library", "Application Support");
    case "win32":
      return process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    default:
      return process.env.XDG_DATA_HOME ?? join(home, ".local", "share");
  }
}

export function getAmazonQDb(): string {
  return process.env.KIT_AMAZONQ_DB ?? join(dataLocalDir(), "amazon-q", "data.sqlite3");
}

/** Defensively pull message text from a string | {content|text|prompt} | array. */
function textOf(node: unknown, depth = 0): string {
  if (typeof node === "string") return node;
  if (depth > 3 || node === null || typeof node !== "object") return "";
  if (Array.isArray(node)) {
    return node
      .map((n) => textOf(n, depth + 1))
      .filter(Boolean)
      .join("\n");
  }
  const obj = node as Record<string, unknown>;
  for (const field of ["content", "text", "prompt"]) {
    const v = obj[field];
    if (typeof v === "string" && v.trim()) return v;
    if (v && typeof v === "object") {
      const nested = textOf(v, depth + 1);
      if (nested) return nested;
    }
  }
  return "";
}

interface HistoryEntry {
  user?: unknown;
  assistant?: unknown;
}
interface ConversationState {
  history?: HistoryEntry[];
}

function indexConversation(db: DatabaseSync, key: string, value: string): { messages: number } {
  let state: ConversationState;
  try {
    state = JSON.parse(value) as ConversationState;
  } catch {
    return { messages: 0 };
  }
  if (!Array.isArray(state.history)) return { messages: 0 };

  const sessionId = `amazon-q:${key}`;
  // `key` is the working-directory path → use it as cwd for project-scoped recall.
  const cwd = key.startsWith("/") || /^[A-Za-z]:\\/.test(key) ? key : undefined;
  upsertSession(db, { sessionId, harness: "amazon-q", project: cwd ? undefined : key });

  let messages = 0;
  state.history.forEach((entry, idx) => {
    const userText = textOf(entry?.user).trim();
    if (userText) {
      const added = insertMessage(db, {
        uuid: `amazon-q:${key}:${idx}:user`,
        sessionId,
        type: "user",
        role: "user",
        content: userText,
        cwd,
      });
      if (added) messages++;
    }
    const assistantText = textOf(entry?.assistant).trim();
    if (assistantText) {
      const added = insertMessage(db, {
        uuid: `amazon-q:${key}:${idx}:assistant`,
        sessionId,
        type: "assistant",
        role: "assistant",
        content: assistantText,
        cwd,
      });
      if (added) messages++;
    }
  });
  return { messages };
}

/** Read ~/…/amazon-q/data.sqlite3 and index every conversation. Idempotent + fail-safe. */
export function indexAmazonQSessions(db: DatabaseSync): IndexResult {
  const result: IndexResult = { files: 0, sessions: 0, messages: 0, toolUses: 0, filesSkipped: 0 };
  const dbPath = getAmazonQDb();
  if (!existsSync(dbPath)) return result;

  let st;
  try {
    st = statSync(dbPath);
  } catch {
    return result;
  }
  const mtimeMs = Math.floor(st.mtimeMs);
  if (isFileIndexed(db, dbPath, mtimeMs, st.size)) {
    result.filesSkipped++;
    return result;
  }

  let src: DatabaseSync;
  try {
    src = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return result; // locked / unreadable → fail-safe
  }

  try {
    let rows: { key: string; value: string }[];
    try {
      rows = src.prepare("SELECT key, value FROM conversations").all() as unknown as {
        key: string;
        value: string;
      }[];
    } catch {
      markFileIndexed(db, dbPath, mtimeMs, st.size); // table absent / differs → fail-safe
      return result;
    }
    for (const row of rows) {
      if (typeof row.value !== "string") continue;
      const counts = indexConversation(db, row.key, row.value);
      if (counts.messages > 0) result.sessions++;
      result.messages += counts.messages;
    }
    result.files++;
  } finally {
    src.close();
  }

  markFileIndexed(db, dbPath, mtimeMs, st.size);
  return result;
}
