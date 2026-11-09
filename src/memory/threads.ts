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
import { realpathSync } from "node:fs";
import { posix, win32 } from "node:path";
import {
  getProjectRecallRoots,
  registerProjectIdentity,
  resolveLocalProjectPath,
} from "./project.js";

export interface SavedThread {
  name: string;
  session_id: string;
  harness: string | null;
  summary: string | null;
  project_path: string | null;
  saved_at: string | null;
}

export interface SaveThreadInput {
  name: string;
  sessionId: string;
  summary?: string;
  projectPath?: string;
  /** Local list scope. This is not evidence of the session's recorded origin. */
  recallProjectPath?: string;
}

/** Compare paths without changing the stored spelling or importing another OS's root. */
function threadScope(roots: string[]): (path: string | null) => boolean {
  const cache = new Map<string, string>();
  const key = (path: string): string => {
    const cached = cache.get(path);
    if (cached !== undefined) return cached;
    const windows = /^(?:[A-Za-z]:[\\/]|\\\\|\/\/)/.test(path);
    if (!windows && !posix.isAbsolute(path)) return "";
    let local = path;
    if (windows === (process.platform === "win32")) {
      try {
        local = realpathSync.native(path);
      } catch {
        local = resolveLocalProjectPath(path);
      }
    }
    const normalized = windows
      ? win32.normalize(local).replaceAll("\\", "/").toLowerCase()
      : posix.normalize(local);
    const result = normalized.replace(/\/+$/, "") || "/";
    cache.set(path, result);
    return result;
  };
  const normalizedRoots = roots.map(key).filter(Boolean);
  return (path) => {
    if (!path) return false;
    const candidate = key(path);
    return normalizedRoots.some(
      (root) => candidate === root || candidate.startsWith(root === "/" ? root : `${root}/`),
    );
  };
}

/** A linked worktree beneath this root still belongs to a different checkout. */
function currentWorktreeScope(root: string): (path: string | null) => boolean {
  const inside = threadScope([root]);
  const nested = getProjectRecallRoots(root).filter(
    (candidate) => inside(candidate) && !threadScope([candidate])(root),
  );
  const outside = threadScope(nested);
  return (path) => inside(path) && !outside(path);
}

function recordedOrigin(db: DatabaseSync, sessionId: string, scope?: string) {
  const matches = scope ? currentWorktreeScope(scope) : undefined;
  let latest: { cwd: string; recall_cwd: string | null } | undefined;
  const rows = db.prepare(
    "SELECT cwd, recall_cwd FROM messages WHERE session_id = ? AND cwd IS NOT NULL AND trim(cwd) != '' ORDER BY timestamp DESC, id DESC",
  );
  for (const row of rows.iterate(sessionId)) {
    const origin = row as { cwd: string; recall_cwd: string | null };
    latest ??= origin;
    if (!matches || matches(origin.recall_cwd ?? origin.cwd)) return origin;
  }
  return latest;
}

export function saveThread(db: DatabaseSync, input: SaveThreadInput): void {
  const origin =
    input.projectPath === undefined
      ? recordedOrigin(db, input.sessionId, input.recallProjectPath)
      : undefined;
  const projectPath = input.projectPath ?? origin?.cwd ?? null;
  const recallPath = input.recallProjectPath ?? origin?.recall_cwd ?? null;
  db.prepare(
    `INSERT INTO saved_threads (name, session_id, summary, project_path, recall_project_path, saved_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(name) DO UPDATE SET
       session_id = excluded.session_id,
       summary = COALESCE(excluded.summary, saved_threads.summary),
       project_path = excluded.project_path,
       recall_project_path = excluded.recall_project_path,
       saved_at = datetime('now')`,
  ).run(input.name, input.sessionId, input.summary ?? null, projectPath, recallPath);
  registerProjectIdentity(db, recallPath ?? projectPath);
}

export function listThreads(db: DatabaseSync, opts: { projectPath?: string } = {}): SavedThread[] {
  const select = `SELECT
      saved_threads.name,
      saved_threads.session_id,
      sessions.harness AS harness,
      saved_threads.summary,
      saved_threads.project_path,
      saved_threads.recall_project_path AS recall_path,
      saved_threads.saved_at
    FROM saved_threads
    LEFT JOIN sessions ON sessions.session_id = saved_threads.session_id`;
  const matches = opts.projectPath
    ? threadScope(getProjectRecallRoots(opts.projectPath, db))
    : undefined;
  const rows = db
    .prepare(`${select} ORDER BY saved_threads.saved_at DESC`)
    .all() as unknown as (SavedThread & { recall_path: string | null })[];
  return rows
    .filter((row) => !matches || matches(row.recall_path ?? row.project_path))
    .map(({ recall_path: _recallPath, ...thread }) => thread);
}

export function getThread(db: DatabaseSync, name: string): SavedThread | undefined {
  return db
    .prepare(
      `SELECT
         saved_threads.name,
         saved_threads.session_id,
         sessions.harness AS harness,
         saved_threads.summary,
         saved_threads.project_path,
         saved_threads.saved_at
       FROM saved_threads
       LEFT JOIN sessions ON sessions.session_id = saved_threads.session_id
       WHERE saved_threads.name = ?`,
    )
    .get(name) as SavedThread | undefined;
}

export function removeThread(db: DatabaseSync, name: string): boolean {
  return Number(db.prepare("DELETE FROM saved_threads WHERE name = ?").run(name).changes) > 0;
}

/** Most recent session in this worktree, without sibling or cross-clone recall. */
export function latestSessionId(
  db: DatabaseSync,
  opts: { projectPath?: string } = {},
): string | undefined {
  const matches = opts.projectPath ? currentWorktreeScope(opts.projectPath) : undefined;
  const rows = db.prepare(
    "SELECT session_id, COALESCE(recall_cwd, cwd) AS scope FROM messages ORDER BY timestamp DESC, id DESC",
  );
  for (const row of rows.iterate()) {
    if (!matches || matches(row.scope as string | null)) return row.session_id as string;
  }
  return undefined;
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

export function resumeCommandsForThread(t: SavedThread): string[] {
  // These commands must remain one literal identifier in every supported shell.
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(t.session_id)) return [];
  if (t.harness === "codex") return [`codex resume ${t.session_id}`];
  if (t.harness === "claude-code") return [`claude --resume ${t.session_id}`];
  if (t.harness === null) {
    return [`claude --resume ${t.session_id}`, `codex resume ${t.session_id}`];
  }
  return [];
}
