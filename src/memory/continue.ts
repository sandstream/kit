/**
 * kit memory — Continue.dev transcript parser (multi-harness).
 *
 * Continue stores each chat as a Session JSON at ~/.continue/sessions/<id>.json
 * (an index lives at sessions.json, which we skip). Types verified against the
 * continuedev/continue source (core/index.d.ts):
 *
 *   Session          { sessionId, title, workspaceDirectory, history: ChatHistoryItem[] }
 *   ChatHistoryItem  { message: ChatMessage, ... }
 *   ChatMessage      { role: 'user'|'assistant'|'system'|'thinking'|'tool', content }
 *   MessageContent   string | ({ type:'text', text } | { type:'imageUrl', ... })[]
 *
 * We index user + assistant turns, tag harness="continue", and — because Session
 * carries workspaceDirectory — set cwd so Continue recall is project-scoped like
 * Claude Code (not global-only). RAW + deterministic; idempotent; no model calls.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { insertMessage, upsertSession, isFileIndexed, markFileIndexed } from "./db.js";
import type { IndexResult } from "./parser.js";

export function getContinueSessionsDir(): string {
  const base = process.env.KIT_CONTINUE_DIR ?? join(homedir(), ".continue");
  return join(base, "sessions");
}

interface ContinuePart {
  type?: string;
  text?: string;
}
interface ContinueMessage {
  role?: string;
  content?: string | ContinuePart[];
}
interface ContinueHistoryItem {
  message?: ContinueMessage;
}
interface ContinueSession {
  sessionId?: string;
  workspaceDirectory?: string;
  history?: ContinueHistoryItem[];
}

/** Flatten Continue MessageContent (string or part array) to plain text. */
function contentText(content: string | ContinuePart[] | undefined): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p?.type === "text" ? (p.text ?? "") : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function indexFile(db: DatabaseSync, filepath: string): { messages: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filepath, "utf8"));
  } catch {
    return { messages: 0 };
  }
  if (parsed === null || typeof parsed !== "object") return { messages: 0 };
  const session = parsed as ContinueSession;
  if (!Array.isArray(session.history)) return { messages: 0 }; // not a Session (e.g. the index)

  const id = session.sessionId ?? basename(filepath, ".json");
  const sessionId = `continue:${id}`;
  const cwd = session.workspaceDirectory || undefined;
  upsertSession(db, {
    sessionId,
    harness: "continue",
    project: cwd ? basename(cwd) : undefined,
  });

  let messages = 0;
  session.history.forEach((item, idx) => {
    const role = item?.message?.role;
    if (role !== "user" && role !== "assistant") return; // skip system/thinking/tool
    const text = contentText(item.message?.content);
    if (!text) return;
    const added = insertMessage(db, {
      uuid: `continue:${id}:${idx}`,
      sessionId,
      type: role,
      role,
      content: text,
      cwd,
    });
    if (added) messages++;
  });
  return { messages };
}

/** Walk ~/.continue/sessions and index every session JSON. Idempotent + incremental. */
export function indexContinueSessions(db: DatabaseSync): IndexResult {
  const dir = getContinueSessionsDir();
  const result: IndexResult = { files: 0, sessions: 0, messages: 0, toolUses: 0, filesSkipped: 0 };
  if (!existsSync(dir)) return result;

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".json") || e.name === "sessions.json") continue;
    const filepath = join(dir, e.name);
    let st;
    try {
      st = statSync(filepath);
    } catch {
      continue;
    }
    const mtimeMs = Math.floor(st.mtimeMs);
    if (isFileIndexed(db, filepath, mtimeMs, st.size)) {
      result.filesSkipped++;
      continue;
    }
    const counts = indexFile(db, filepath);
    markFileIndexed(db, filepath, mtimeMs, st.size);
    result.files++;
    result.sessions++;
    result.messages += counts.messages;
  }
  return result;
}
