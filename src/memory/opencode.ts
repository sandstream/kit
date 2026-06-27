/**
 * kit memory — OpenCode session parser (multi-harness).
 *
 * OpenCode persists sessions under `$OPENCODE_DATA_DIR` (default
 * `~/.local/share/opencode`) as flat JSON in a `storage/` tree:
 *
 *   storage/session/<projectHash>/<sessionID>.json  — session info (id, directory)
 *   storage/message/<sessionID>/msg_<id>.json        — one file per message (role, time)
 *   storage/part/.../<prt>.json                      — message content, split into parts
 *
 * The message TEXT lives in the *parts*, not the message file. Rather than guess
 * the exact part-directory nesting (it has varied across versions), we glob every
 * part file and group by the `messageID` field each part carries, then attach the
 * `type: "text"` parts to their message. Verified against sst/opencode's
 * message-v2 schema (role ∈ user|assistant; text part = { type:"text", text }).
 *
 * Defensive + strict: anything that doesn't match the documented shape is skipped,
 * so on an unrecognized layout (e.g. newer SQLite-backed installs) this indexes
 * nothing rather than garbage. RAW + deterministic; no model calls.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { insertMessage, upsertSession } from "./db.js";
import type { IndexResult } from "./parser.js";

export function getOpenCodeStorageDir(): string {
  const base =
    process.env.KIT_OPENCODE_DIR ??
    process.env.OPENCODE_DATA_DIR ??
    join(homedir(), ".local", "share", "opencode");
  return join(base, "storage");
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
 */
export function indexOpenCodeSessions(db: DatabaseSync): IndexResult {
  const result: IndexResult = { files: 0, sessions: 0, messages: 0, toolUses: 0, filesSkipped: 0 };
  const storage = getOpenCodeStorageDir();
  if (!existsSync(storage)) return result;

  const { project: projectOf, cwd: cwdOf } = readSessions(storage);
  const messages = readMessages(storage);
  result.files = messages.size;
  if (messages.size === 0) return result;
  const content = readParts(storage, messages);

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
  return result;
}
