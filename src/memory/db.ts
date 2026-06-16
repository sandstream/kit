/**
 * kit memory — local SQLite store (node:sqlite + FTS5).
 *
 * Schema is derived from cloudctx (MIT — github.com/chadptk1238/cloudctx): we reuse
 * its proven table layout, PRAGMAs and FTS5 design. Differences: kit is a Node/TS
 * project, so we use the built-in `node:sqlite` driver instead of `bun:sqlite`; we
 * add a `harness` column (kit is harness-agnostic) and a `pending_actions` table
 * (PAL — the structured, actionable layer on top of raw conversation memory).
 *
 * Memory is RAW and append-only: one row per message, no summarisation. Retrieval
 * (FTS5) happens at time of work — store everything raw, search on demand. This DB
 * is secret-dense (it indexes private transcripts): it lives only under ~/.kit/ with
 * 0600 perms and is never committed. Redaction / encryption is stage B7.
 */
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, chmodSync, statSync } from "node:fs";
import type {
  MemoryStats,
  MessageInput,
  SearchHit,
  SessionInput,
  ToolUseInput,
} from "./types.js";

export const SCHEMA_VERSION = 3;

export function getMemoryDir(): string {
  return process.env.KIT_MEMORY_DIR ?? join(homedir(), ".kit");
}

export function getMemoryDbPath(): string {
  return process.env.KIT_MEMORY_DB ?? join(getMemoryDir(), "memory.db");
}

function ensureMemoryDir(): void {
  const dir = getMemoryDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT UNIQUE NOT NULL,
  harness TEXT NOT NULL DEFAULT 'claude-code',
  project TEXT,
  first_message_at TEXT,
  last_message_at TEXT,
  message_count INTEGER DEFAULT 0,
  is_agent_sidechain INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT UNIQUE,
  session_id TEXT NOT NULL,
  parent_uuid TEXT,
  type TEXT NOT NULL,
  role TEXT,
  content TEXT,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  timestamp TEXT,
  cwd TEXT,
  git_branch TEXT,
  version TEXT
);

CREATE TABLE IF NOT EXISTS tool_uses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_uuid TEXT,
  session_id TEXT,
  tool_name TEXT,
  tool_input TEXT,
  timestamp TEXT
);

CREATE TABLE IF NOT EXISTS saved_threads (
  name TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  summary TEXT,
  project_path TEXT,
  saved_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pending_actions (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'open',
  title TEXT NOT NULL,
  detail TEXT,
  scope TEXT,
  kind TEXT NOT NULL DEFAULT 'manual',
  verify_cmd TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  next_check TEXT,
  snooze_until TEXT,
  closed_at TEXT,
  verify_passes INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS file_index (
  path TEXT PRIMARY KEY,
  mtime_ms INTEGER NOT NULL,
  size INTEGER NOT NULL,
  indexed_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_type ON messages(type);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
CREATE INDEX IF NOT EXISTS idx_tool_uses_tool ON tool_uses(tool_name);
CREATE INDEX IF NOT EXISTS idx_pending_status ON pending_actions(status);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  content=messages,
  content_rowid=id
);

CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;
`;

function ensureColumn(
  db: DatabaseSync,
  table: string,
  column: string,
  decl: string,
): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((col) => col.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}

function migrate(db: DatabaseSync): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_meta (version INTEGER NOT NULL)");
  db.exec(SCHEMA_SQL);
  // v2: pending_actions.verify_passes (N=2 auto-verify confirmation). Add to
  // tables created before this column existed.
  ensureColumn(db, "pending_actions", "verify_passes", "INTEGER NOT NULL DEFAULT 0");
  const row = db.prepare("SELECT version FROM schema_meta LIMIT 1").get() as
    | { version: number }
    | undefined;
  if (!row) {
    db.prepare("INSERT INTO schema_meta(version) VALUES (?)").run(SCHEMA_VERSION);
  } else if (row.version < SCHEMA_VERSION) {
    db.prepare("UPDATE schema_meta SET version = ?").run(SCHEMA_VERSION);
  }
}

/**
 * Open (creating + migrating if needed) the memory database. Pass ":memory:" for
 * an ephemeral in-process DB (tests). Otherwise defaults to ~/.kit/memory.db.
 */
export function openMemoryDb(path?: string): DatabaseSync {
  const dbPath = path ?? getMemoryDbPath();
  if (dbPath !== ":memory:") ensureMemoryDir();
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = OFF");
  migrate(db);
  if (dbPath !== ":memory:" && existsSync(dbPath)) {
    try {
      chmodSync(dbPath, 0o600);
    } catch {
      // best-effort: non-POSIX filesystems may not support chmod
    }
  }
  return db;
}

/** Has this file already been indexed at exactly this mtime + size? (incremental index) */
export function isFileIndexed(
  db: DatabaseSync,
  path: string,
  mtimeMs: number,
  size: number,
): boolean {
  return !!db
    .prepare("SELECT 1 FROM file_index WHERE path = ? AND mtime_ms = ? AND size = ?")
    .get(path, mtimeMs, size);
}

/** Record (or refresh) a file's mtime + size after indexing it. */
export function markFileIndexed(
  db: DatabaseSync,
  path: string,
  mtimeMs: number,
  size: number,
): void {
  db.prepare(
    `INSERT INTO file_index (path, mtime_ms, size, indexed_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(path) DO UPDATE SET mtime_ms = excluded.mtime_ms, size = excluded.size, indexed_at = datetime('now')`,
  ).run(path, mtimeMs, size);
}

export function upsertSession(db: DatabaseSync, s: SessionInput): void {
  db.prepare(
    `INSERT INTO sessions (session_id, harness, project, first_message_at, last_message_at, is_agent_sidechain)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       last_message_at = COALESCE(excluded.last_message_at, sessions.last_message_at),
       first_message_at = COALESCE(sessions.first_message_at, excluded.first_message_at),
       project = COALESCE(excluded.project, sessions.project),
       harness = excluded.harness,
       is_agent_sidechain = MAX(sessions.is_agent_sidechain, excluded.is_agent_sidechain)`,
  ).run(
    s.sessionId,
    s.harness,
    s.project ?? null,
    s.firstMessageAt ?? null,
    s.lastMessageAt ?? null,
    s.isAgentSidechain ? 1 : 0,
  );
}

/** Insert a message idempotently (by uuid). Returns true if a new row was added. */
export function insertMessage(db: DatabaseSync, m: MessageInput): boolean {
  const res = db
    .prepare(
      `INSERT OR IGNORE INTO messages
       (uuid, session_id, parent_uuid, type, role, content, model, input_tokens, output_tokens, timestamp, cwd, git_branch, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      m.uuid,
      m.sessionId,
      m.parentUuid ?? null,
      m.type,
      m.role ?? null,
      m.content ?? null,
      m.model ?? null,
      m.inputTokens ?? null,
      m.outputTokens ?? null,
      m.timestamp ?? null,
      m.cwd ?? null,
      m.gitBranch ?? null,
      m.version ?? null,
    );
  if (Number(res.changes) > 0) {
    db.prepare(
      "UPDATE sessions SET message_count = message_count + 1 WHERE session_id = ?",
    ).run(m.sessionId);
    return true;
  }
  return false;
}

export function insertToolUse(db: DatabaseSync, t: ToolUseInput): void {
  db.prepare(
    `INSERT INTO tool_uses (message_uuid, session_id, tool_name, tool_input, timestamp)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    t.messageUuid ?? null,
    t.sessionId ?? null,
    t.toolName,
    t.toolInput ?? null,
    t.timestamp ?? null,
  );
}

export interface SearchOptions {
  limit?: number;
  /** Restrict to messages whose cwd is this repo root (or a subdirectory). */
  projectPath?: string;
}

/**
 * Full-text search over raw message content (FTS5 MATCH, ranked by `rank`).
 * Pass opts.projectPath to scope to one repo (relevance + blast-radius); omit it
 * for cross-project ("--global") recall over the personal store.
 */
export function searchMessages(
  db: DatabaseSync,
  query: string,
  opts: SearchOptions = {},
): SearchHit[] {
  const limit = opts.limit ?? 20;
  const params: (string | number)[] = [query];
  let where = "messages_fts MATCH ?";
  if (opts.projectPath) {
    where += " AND (m.cwd = ? OR m.cwd LIKE ?)";
    params.push(opts.projectPath, `${opts.projectPath}/%`);
  }
  params.push(limit);
  return db
    .prepare(
      `SELECT m.id AS id, m.uuid AS uuid, m.session_id AS sessionId, m.role AS role,
              m.content AS content, m.timestamp AS timestamp
       FROM messages_fts f
       JOIN messages m ON m.id = f.rowid
       WHERE ${where}
       ORDER BY rank
       LIMIT ?`,
    )
    .all(...params) as unknown as SearchHit[];
}

export function getStats(db: DatabaseSync): MemoryStats {
  const count = (sql: string): number => {
    const r = db.prepare(sql).get() as { n: number } | undefined;
    return r ? Number(r.n) : 0;
  };
  const dbPath = getMemoryDbPath();
  let sizeBytes = 0;
  if (dbPath !== ":memory:" && existsSync(dbPath)) {
    try {
      sizeBytes = statSync(dbPath).size;
    } catch {
      // best-effort: size is informational only
    }
  }
  return {
    sessions: count("SELECT COUNT(*) AS n FROM sessions"),
    messages: count("SELECT COUNT(*) AS n FROM messages"),
    toolUses: count("SELECT COUNT(*) AS n FROM tool_uses"),
    pendingOpen: count(
      "SELECT COUNT(*) AS n FROM pending_actions WHERE status = 'open'",
    ),
    dbPath,
    sizeBytes,
  };
}
