/**
 * kit memory — named copilots (saved threads).
 *
 * Claude Code's resume list labels sessions by the first message you happened to
 * type, so the thread you want is unfindable. Here you bookmark the threads worth
 * keeping under a real name ("a fleet of named copilots"); a small curated list
 * replaces the scrap heap. Scoped per project by default (the personal store holds
 * all projects; this just filters). Pure read/write — no model calls.
 */
import type { DatabaseSync } from "node:sqlite";

export interface SavedThread {
  name: string;
  session_id: string;
  summary: string | null;
  project_path: string | null;
  saved_at: string | null;
}

export interface SaveThreadInput {
  name: string;
  sessionId: string;
  summary?: string;
  projectPath?: string;
}

export function saveThread(db: DatabaseSync, input: SaveThreadInput): void {
  db.prepare(
    `INSERT INTO saved_threads (name, session_id, summary, project_path, saved_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(name) DO UPDATE SET
       session_id = excluded.session_id,
       summary = COALESCE(excluded.summary, saved_threads.summary),
       project_path = COALESCE(excluded.project_path, saved_threads.project_path),
       saved_at = datetime('now')`,
  ).run(input.name, input.sessionId, input.summary ?? null, input.projectPath ?? null);
}

export function listThreads(db: DatabaseSync, opts: { projectPath?: string } = {}): SavedThread[] {
  if (opts.projectPath) {
    return db
      .prepare("SELECT * FROM saved_threads WHERE project_path = ? ORDER BY saved_at DESC")
      .all(opts.projectPath) as unknown as SavedThread[];
  }
  return db
    .prepare("SELECT * FROM saved_threads ORDER BY saved_at DESC")
    .all() as unknown as SavedThread[];
}

export function getThread(db: DatabaseSync, name: string): SavedThread | undefined {
  return db.prepare("SELECT * FROM saved_threads WHERE name = ?").get(name) as
    | SavedThread
    | undefined;
}

export function removeThread(db: DatabaseSync, name: string): boolean {
  return Number(db.prepare("DELETE FROM saved_threads WHERE name = ?").run(name).changes) > 0;
}

/** Most recent session that touched this project (by message timestamp). */
export function latestSessionId(
  db: DatabaseSync,
  opts: { projectPath?: string } = {},
): string | undefined {
  let row: { session_id: string } | undefined;
  if (opts.projectPath) {
    row = db
      .prepare(
        `SELECT session_id FROM messages
         WHERE cwd = ? OR cwd LIKE ?
         ORDER BY timestamp DESC LIMIT 1`,
      )
      .get(opts.projectPath, `${opts.projectPath}/%`) as { session_id: string } | undefined;
  } else {
    row = db.prepare("SELECT session_id FROM messages ORDER BY timestamp DESC LIMIT 1").get() as
      | { session_id: string }
      | undefined;
  }
  return row?.session_id;
}

/** Resolve a thread by name, or by 1-based index into the (scoped) list. */
export function resolveThread(
  db: DatabaseSync,
  ref: string,
  opts: { projectPath?: string } = {},
): SavedThread | undefined {
  if (/^\d+$/.test(ref)) {
    return listThreads(db, opts)[Number(ref) - 1];
  }
  return getThread(db, ref);
}
