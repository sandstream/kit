/**
 * kit memory — Cursor transcript parser (multi-harness).
 *
 * Cursor stores chat in a SQLite DB at globalStorage/state.vscdb, table
 * `cursorDiskKV`: one row per "bubble" (message), keyed
 * `bubbleId:<composerId>:<bubbleId>`, plus `composerData:<id>` session metadata.
 * The bubble value is JSON with `type` (1 = user, 2 = assistant) and `text`.
 *
 * Cursor's store is APP-INTERNAL and community-reverse-engineered (not an
 * official schema), so this parser is deliberately DEFENSIVE: it maps only the
 * known fields and, if the table or shape ever differs, indexes nothing rather
 * than guessing — it can never write WRONG data, only less of it. Read-only,
 * idempotent (uuid = the bubble key), fail-safe, no model calls.
 *
 * Limitation: Cursor keys by composerId, not project path — messages carry no
 * cwd and surface in `--global` recall, not project-scoped search.
 */
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { insertMessage, upsertSession, isFileIndexed, markFileIndexed } from "./db.js";
import type { IndexResult } from "./parser.js";

export function getCursorStateDb(): string {
  if (process.env.KIT_CURSOR_DB) return process.env.KIT_CURSOR_DB;
  const home = homedir();
  const sub = join("Cursor", "User", "globalStorage", "state.vscdb");
  switch (process.platform) {
    case "darwin":
      return join(home, "Library", "Application Support", sub);
    case "win32":
      return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), sub);
    default:
      return join(home, ".config", sub);
  }
}

interface Bubble {
  type?: number;
  text?: string;
}

/** key = "bubbleId:<composerId>:<bubbleId>" → composerId */
function composerIdFromKey(key: string): string {
  return key.split(":")[1] ?? "unknown";
}

export function indexCursorSessions(db: DatabaseSync): IndexResult {
  const result: IndexResult = { files: 0, sessions: 0, messages: 0, toolUses: 0, filesSkipped: 0 };
  const dbPath = getCursorStateDb();
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
    return result; // locked / unreadable while Cursor runs → fail-safe, retry next run
  }

  try {
    let rows: { key: string; value: string }[];
    try {
      rows = src
        .prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%'")
        .all() as unknown as { key: string; value: string }[];
    } catch {
      // table absent / schema differs → fail-safe (index nothing, never wrong data)
      markFileIndexed(db, dbPath, mtimeMs, st.size);
      return result;
    }

    const sessionsSeen = new Set<string>();
    for (const row of rows) {
      let bubble: Bubble;
      try {
        bubble = JSON.parse(row.value) as Bubble;
      } catch {
        continue;
      }
      if (bubble.type !== 1 && bubble.type !== 2) continue; // only user/assistant turns
      const text = typeof bubble.text === "string" ? bubble.text.trim() : "";
      if (!text) continue; // tool-only / empty bubbles carry no searchable text

      const sessionId = `cursor:${composerIdFromKey(row.key)}`;
      if (!sessionsSeen.has(sessionId)) {
        upsertSession(db, { sessionId, harness: "cursor" });
        sessionsSeen.add(sessionId);
      }
      const role = bubble.type === 1 ? "user" : "assistant";
      const added = insertMessage(db, {
        uuid: `cursor:${row.key}`, // stable per bubble → idempotent
        sessionId,
        type: role,
        role,
        content: text,
      });
      if (added) result.messages++;
    }
    result.sessions += sessionsSeen.size;
    result.files++;
  } finally {
    src.close();
  }

  markFileIndexed(db, dbPath, mtimeMs, st.size);
  return result;
}
