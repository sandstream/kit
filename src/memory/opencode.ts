/**
 * kit memory — OpenCode session parser (multi-harness).
 *
 * OpenCode persists sessions under `$OPENCODE_DATA_DIR` (default
 * `~/.local/share/opencode`). The storage format changed across versions, so we
 * support BOTH, preferring the current one:
 *
 *  1. SQLite (current, ≥ the mid-2026 `opencode.db` migration). One DB at
 *     `<dataDir>/opencode.db` with relational tables — verified against
 *     opencode-ai@1.17.x:
 *       session(id, directory, time_created, time_updated, …)
 *       message(id, session_id, time_created, data)   — data = JSON Message ({role,…})
 *       part   (id, message_id, session_id, data)      — data = JSON Part (text = {type:"text",text})
 *     `session.directory` is the cwd; role lives in `message.data`; the message
 *     TEXT lives in the `type:"text"` parts' `data`.
 *
 *  2. Flat JSON (legacy) under a `storage/` tree:
 *       storage/session/<projectHash>/<sessionID>.json  — session info (id, directory)
 *       storage/message/<sessionID>/msg_<id>.json        — one file per message (role, time)
 *       storage/part/.../<prt>.json                      — message content, split into parts
 *     The TEXT lives in the parts; we glob every part file and group by the
 *     `messageID` field each carries (the nesting has varied across versions).
 *
 * Both paths share the same shape contract (role ∈ user|assistant; text part =
 * { type:"text", text }) and the same stable uuid (`opencode:<sessionID>:<messageID>`),
 * so a given install is read by exactly one path and re-runs dedupe in insertMessage.
 *
 * Defensive + strict: anything that doesn't match the documented shape is skipped,
 * so on an unrecognized layout this indexes nothing rather than garbage. RAW +
 * deterministic; no model calls.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { insertMessage, upsertSession } from "./db.js";
import type { IndexResult } from "./parser.js";

/** OpenCode's data dir (parent of both `storage/` and `opencode.db`). */
export function getOpenCodeDataDir(): string {
  return (
    process.env.KIT_OPENCODE_DIR ??
    process.env.OPENCODE_DATA_DIR ??
    join(homedir(), ".local", "share", "opencode")
  );
}

export function getOpenCodeStorageDir(): string {
  return join(getOpenCodeDataDir(), "storage");
}

export function getOpenCodeDbPath(): string {
  return join(getOpenCodeDataDir(), "opencode.db");
}

/** Recursively yield every *.json file under `dir`. */
function* walkJson(dir: string): Generator<string> {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkJson(p);
    else if (entry.isFile() && entry.name.endsWith(".json")) yield p;
  }
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A message's role + timestamp, tolerant of `time:{created}` vs `time_created`. */
interface MsgInfo {
  sessionId: string;
  role: "user" | "assistant";
  timestamp?: string;
}

function timeOf(obj: Record<string, unknown>): string | undefined {
  const time = obj.time;
  if (time && typeof time === "object") {
    const created = (time as { created?: unknown }).created;
    if (typeof created === "number") return new Date(created).toISOString();
    if (typeof created === "string") return created;
  }
  const flat = obj.time_created;
  if (typeof flat === "number") return new Date(flat).toISOString();
  if (typeof flat === "string") return flat;
  return undefined;
}

/** Pull the `type:"text"` text out of a part object (skips ignored/empty). */
function textPartContent(part: Record<string, unknown>): string | null {
  if (part.type !== "text") return null;
  if (part.ignored === true) return null;
  const text = part.text;
  return typeof text === "string" && text !== "" ? text : null;
}

/** The role from a message's `data` JSON blob (SQLite path). */
function roleFromData(data: unknown): "user" | "assistant" | null {
  if (typeof data !== "string") return null;
  try {
    const obj = JSON.parse(data) as { role?: unknown };
    return obj.role === "user" || obj.role === "assistant" ? obj.role : null;
  } catch {
    return null;
  }
}

/** sessionID → its project basename + cwd, read from the session info files. */
function readSessions(storage: string): {
  project: Map<string, string | undefined>;
  cwd: Map<string, string | undefined>;
} {
  const project = new Map<string, string | undefined>();
  const cwd = new Map<string, string | undefined>();
  for (const f of walkJson(join(storage, "session"))) {
    const info = readJson(f);
    if (!info) continue;
    const id = typeof info.id === "string" ? info.id : basename(f, ".json");
    const dir = typeof info.directory === "string" ? info.directory : undefined;
    project.set(id, dir ? basename(dir) : undefined);
    cwd.set(id, dir);
  }
  return { project, cwd };
}

/** messageID → role + timestamp + session, for user/assistant messages only. */
function readMessages(storage: string): Map<string, MsgInfo> {
  const messages = new Map<string, MsgInfo>();
  for (const f of walkJson(join(storage, "message"))) {
    const msg = readJson(f);
    if (!msg) continue;
    const role = msg.role;
    if (role !== "user" && role !== "assistant") continue;
    const id = typeof msg.id === "string" ? msg.id : basename(f, ".json").replace(/^msg_/, "");
    const sessionId = typeof msg.sessionID === "string" ? msg.sessionID : basename(join(f, "..")); // parent dir
    messages.set(id, { sessionId, role, timestamp: timeOf(msg) });
  }
  return messages;
}

/** messageID → its text-part strings. Grouped by the part's `messageID` field so we
 *  never have to guess the part-directory nesting. */
function readParts(storage: string, known: Map<string, MsgInfo>): Map<string, string[]> {
  const content = new Map<string, string[]>();
  for (const f of walkJson(join(storage, "part"))) {
    const part = readJson(f);
    if (!part) continue;
    const messageId = part.messageID;
    if (typeof messageId !== "string" || !known.has(messageId)) continue;
    const text = textPartContent(part);
    if (!text) continue;
    const arr = content.get(messageId) ?? [];
    arr.push(text);
    content.set(messageId, arr);
  }
  return content;
}

/**
 * Index OpenCode sessions into the store. Idempotent — message uuids are stable
 * (`opencode:<sessionID>:<messageID>`), so re-runs dedupe in insertMessage.
 *
 * Prefers the current SQLite store (`opencode.db`); falls back to the legacy
 * flat-JSON `storage/` tree for older installs.
 */
export function indexOpenCodeSessions(db: DatabaseSync): IndexResult {
  const dbPath = getOpenCodeDbPath();
  if (existsSync(dbPath)) return indexOpenCodeDb(dbPath, db);
  return indexOpenCodeFlat(db);
}

/** SQLite path (current OpenCode): read `opencode.db` read-only. */
function indexOpenCodeDb(dbPath: string, db: DatabaseSync): IndexResult {
  const result: IndexResult = { files: 0, sessions: 0, messages: 0, toolUses: 0, filesSkipped: 0 };
  let src: DatabaseSync;
  try {
    src = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return result; // locked / unreadable / not-a-db → index nothing rather than crash
  }
  try {
    // session.directory is the cwd; its basename is the project.
    const cwdOf = new Map<string, string | undefined>();
    const projectOf = new Map<string, string | undefined>();
    for (const s of src.prepare("SELECT id, directory FROM session").all() as {
      id: string;
      directory: string | null;
    }[]) {
      cwdOf.set(s.id, s.directory ?? undefined);
      projectOf.set(s.id, s.directory ? basename(s.directory) : undefined);
    }

    // messages: role lives in `data`; timestamp is the `time_created` column.
    // Ordered so first/last-message-at per session are meaningful.
    const messages = new Map<string, MsgInfo>();
    for (const m of src
      .prepare("SELECT id, session_id, time_created, data FROM message ORDER BY time_created ASC")
      .all() as { id: string; session_id: string; time_created: number; data: string }[]) {
      const role = roleFromData(m.data);
      if (!role) continue;
      messages.set(m.id, {
        sessionId: m.session_id,
        role,
        timestamp:
          typeof m.time_created === "number" ? new Date(m.time_created).toISOString() : undefined,
      });
    }
    result.files = messages.size;
    if (messages.size === 0) return result;

    // parts: text content grouped by message_id.
    const content = new Map<string, string[]>();
    for (const p of src.prepare("SELECT message_id, data FROM part").all() as {
      message_id: string;
      data: string;
    }[]) {
      if (!messages.has(p.message_id)) continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(p.data) as Record<string, unknown>;
      } catch {
        continue;
      }
      const text = textPartContent(parsed);
      if (!text) continue;
      const arr = content.get(p.message_id) ?? [];
      arr.push(text);
      content.set(p.message_id, arr);
    }

    writeMessages(db, messages, content, projectOf, cwdOf, result);
    return result;
  } finally {
    src.close();
  }
}

/** Legacy flat-JSON path (older OpenCode): walk the `storage/` tree. */
function indexOpenCodeFlat(db: DatabaseSync): IndexResult {
  const result: IndexResult = { files: 0, sessions: 0, messages: 0, toolUses: 0, filesSkipped: 0 };
  const storage = getOpenCodeStorageDir();
  if (!existsSync(storage)) return result;

  const { project: projectOf, cwd: cwdOf } = readSessions(storage);
  const messages = readMessages(storage);
  result.files = messages.size;
  if (messages.size === 0) return result;
  const content = readParts(storage, messages);

  writeMessages(db, messages, content, projectOf, cwdOf, result);
  return result;
}

/** Shared store-writer for both the SQLite and flat-JSON paths. Mutates `result`. */
function writeMessages(
  db: DatabaseSync,
  messages: Map<string, MsgInfo>,
  content: Map<string, string[]>,
  projectOf: Map<string, string | undefined>,
  cwdOf: Map<string, string | undefined>,
  result: IndexResult,
): void {
  const sessionFirst = new Map<string, string>();
  const sessionLast = new Map<string, string>();
  const sessionsSeen = new Set<string>();
  for (const [messageId, info] of messages) {
    const parts = content.get(messageId);
    if (!parts || parts.length === 0) continue;
    const added = insertMessage(db, {
      uuid: `opencode:${info.sessionId}:${messageId}`,
      sessionId: info.sessionId,
      type: info.role === "assistant" ? "assistant" : "user",
      role: info.role,
      content: parts.join("\n"),
      timestamp: info.timestamp,
      cwd: cwdOf.get(info.sessionId),
    });
    sessionsSeen.add(info.sessionId);
    if (info.timestamp) {
      if (!sessionFirst.has(info.sessionId)) sessionFirst.set(info.sessionId, info.timestamp);
      sessionLast.set(info.sessionId, info.timestamp);
    }
    if (added) result.messages++;
  }

  for (const sessionId of sessionsSeen) {
    upsertSession(db, {
      sessionId,
      harness: "opencode",
      project: projectOf.get(sessionId),
      firstMessageAt: sessionFirst.get(sessionId),
      lastMessageAt: sessionLast.get(sessionId),
    });
    result.sessions++;
  }
}
