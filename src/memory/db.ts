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
import { existsSync, mkdirSync, statSync } from "node:fs";
import type { MemoryStats, MessageInput, SearchHit, SessionInput, ToolUseInput } from "./types.js";
import { summarizeTokens } from "./stats.js";
import { redactSecrets } from "../utils/redactSecrets.js";
import { secureFile, secureDir } from "../utils/secure-perms.js";

export const SCHEMA_VERSION = 4;

/**
 * Opt-in redaction-at-capture (KIT_MEMORY_REDACT=1). The memory store is raw by
 * default; a regulated/air-gapped deployment can have secret-shaped substrings
 * masked BEFORE they ever land in memory.db, so a leaked key in a transcript is
 * never persisted (spillage prevention). Off by default — no behavior change.
 */
function captureRedactEnabled(): boolean {
  return ["1", "true", "yes"].includes((process.env.KIT_MEMORY_REDACT ?? "").trim().toLowerCase());
}

/** Apply capture-time redaction to a stored text field when enabled. */
function captureText(text: string | null | undefined): string | null {
  if (text == null) return null;
  return captureRedactEnabled() ? redactSecrets(text) : text;
}

export function getMemoryDir(): string {
  return process.env.KIT_MEMORY_DIR ?? join(homedir(), ".kit");
}

export function getMemoryDbPath(): string {
  return process.env.KIT_MEMORY_DB ?? join(getMemoryDir(), "memory.db");
}

function ensureMemoryDir(): void {
  const dir = getMemoryDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  // Enforce owner-only unconditionally: a pre-existing dir (created before this
  // hardening, or with a looser umask) would otherwise stay world-readable. Also
  // covers Windows, where NTFS ignores the mkdir mode bits — #43.
  secureDir(dir);
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
  cache_read_input_tokens INTEGER,
  cache_creation_input_tokens INTEGER,
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
  verify_check TEXT,
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

CREATE TABLE IF NOT EXISTS query_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query TEXT NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 0,
  project_path TEXT,
  harness TEXT,
  executed_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_type ON messages(type);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
CREATE INDEX IF NOT EXISTS idx_tool_uses_tool ON tool_uses(tool_name);
CREATE INDEX IF NOT EXISTS idx_pending_status ON pending_actions(status);
CREATE INDEX IF NOT EXISTS idx_query_log_executed ON query_log(executed_at);

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

function ensureColumn(db: DatabaseSync, table: string, column: string, decl: string): void {
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
  // v3: pending_actions.verify_check (declarative typed verify replacing raw
  // shell verify_cmd). Legacy verify_cmd rows have a NULL verify_check and are
  // never auto-executed.
  ensureColumn(db, "pending_actions", "verify_check", "TEXT");
  // v4: prompt-cache token columns on messages (cache-hit economy). Older rows
  // stay NULL — cache stats populate going forward (input/output were always
  // captured); query_log is created by SCHEMA_SQL above.
  ensureColumn(db, "messages", "cache_read_input_tokens", "INTEGER");
  ensureColumn(db, "messages", "cache_creation_input_tokens", "INTEGER");
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
      secureFile(dbPath); // 0o600 on POSIX, icacls owner-only on Windows — #43
      // WAL mode spills the secret-dense content into -wal/-shm sidecars; secure
      // those too or the data leaks through a world-readable side channel.
      for (const sidecar of [`${dbPath}-wal`, `${dbPath}-shm`]) {
        if (existsSync(sidecar)) secureFile(sidecar);
      }
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
       (uuid, session_id, parent_uuid, type, role, content, model, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, timestamp, cwd, git_branch, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      m.uuid,
      m.sessionId,
      m.parentUuid ?? null,
      m.type,
      m.role ?? null,
      captureText(m.content),
      m.model ?? null,
      m.inputTokens ?? null,
      m.outputTokens ?? null,
      m.cacheReadTokens ?? null,
      m.cacheCreationTokens ?? null,
      m.timestamp ?? null,
      m.cwd ?? null,
      m.gitBranch ?? null,
      m.version ?? null,
    );
  if (Number(res.changes) > 0) {
    db.prepare("UPDATE sessions SET message_count = message_count + 1 WHERE session_id = ?").run(
      m.sessionId,
    );
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
    captureText(t.toolInput),
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
/**
 * Turn a raw user query into a safe FTS5 MATCH expression. A raw string is
 * otherwise parsed AS an FTS5 expression, so a hyphen, colon, quote, `*`, or a
 * bare `AND`/`OR`/`NEAR` either crashes the query ("no such column: …") or acts
 * as an unintended operator. We split on whitespace, quote each term (escaping
 * embedded quotes by doubling them — the FTS5 string-literal rule), and
 * prefix-match it; terms are joined by implicit AND. Returns "" for an
 * empty/whitespace query so the caller can short-circuit.
 */
export function toFtsMatchQuery(raw: string): string {
  const terms = raw.trim().split(/\s+/).filter(Boolean);
  return terms.map((t) => `"${t.replace(/"/g, '""')}"*`).join(" ");
}

export function searchMessages(
  db: DatabaseSync,
  query: string,
  opts: SearchOptions = {},
): SearchHit[] {
  const match = toFtsMatchQuery(query);
  if (!match) return [];
  const limit = opts.limit ?? 20;
  const params: (string | number)[] = [match];
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

export interface QueryLogInput {
  query: string;
  hitCount: number;
  projectPath?: string;
  harness?: string;
}

/**
 * Record one recall (a `kit memory search`) into query_log — the basis for the
 * "how often is the store actually used" stat. Append-only, best-effort: a
 * logging failure must never break the search itself (callers wrap in try/catch).
 */
export function recordQuery(db: DatabaseSync, q: QueryLogInput): void {
  db.prepare(
    `INSERT INTO query_log (query, hit_count, project_path, harness, executed_at)
     VALUES (?, ?, ?, ?, datetime('now'))`,
  ).run(q.query, q.hitCount, q.projectPath ?? null, q.harness ?? null);
}

/**
 * Most-recent messages by wall-clock time (newest first) — the basis for session
 * recovery (re-injecting "where you left off" after a compaction/resume). Unlike
 * searchMessages this needs no query; pass opts.projectPath to scope to one repo.
 * Skips empty-content rows so the recovery block stays signal, not blank tool turns.
 */
export function recentMessages(db: DatabaseSync, opts: SearchOptions = {}): SearchHit[] {
  const limit = opts.limit ?? 10;
  const params: (string | number)[] = [];
  let where = "content IS NOT NULL AND content != ''";
  if (opts.projectPath) {
    where += " AND (cwd = ? OR cwd LIKE ?)";
    params.push(opts.projectPath, `${opts.projectPath}/%`);
  }
  params.push(limit);
  return db
    .prepare(
      `SELECT id, uuid, session_id AS sessionId, role, content, timestamp
       FROM messages
       WHERE ${where}
       ORDER BY timestamp DESC, id DESC
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
  const byHarness = (
    db
      .prepare(
        "SELECT harness, COUNT(*) AS n FROM sessions GROUP BY harness ORDER BY n DESC, harness ASC",
      )
      .all() as { harness: string; n: number }[]
  ).map((r) => ({ harness: r.harness, sessions: Number(r.n) }));

  const sessions = count("SELECT COUNT(*) AS n FROM sessions");
  const messages = count("SELECT COUNT(*) AS n FROM messages");

  // Token economy — SUM the raw columns, then derive ratios via the pure helper.
  const t = db
    .prepare(
      `SELECT COALESCE(SUM(input_tokens), 0) AS i,
              COALESCE(SUM(output_tokens), 0) AS o,
              COALESCE(SUM(cache_read_input_tokens), 0) AS cr,
              COALESCE(SUM(cache_creation_input_tokens), 0) AS cc
       FROM messages`,
    )
    .get() as { i: number; o: number; cr: number; cc: number };
  const summary = summarizeTokens({
    inputTokens: Number(t.i),
    outputTokens: Number(t.o),
    cacheReadTokens: Number(t.cr),
    cacheCreationTokens: Number(t.cc),
  });
  const byModel = (
    db
      .prepare(
        `SELECT COALESCE(model, '(unknown)') AS model, COUNT(*) AS n,
                COALESCE(SUM(input_tokens), 0) AS i, COALESCE(SUM(output_tokens), 0) AS o
         FROM messages WHERE input_tokens IS NOT NULL OR output_tokens IS NOT NULL
         GROUP BY model ORDER BY (i + o) DESC LIMIT 5`,
      )
      .all() as { model: string; n: number; i: number; o: number }[]
  ).map((r) => ({
    model: r.model,
    messages: Number(r.n),
    inputTokens: Number(r.i),
    outputTokens: Number(r.o),
  }));

  // Recall usage from query_log.
  const recallTotal = count("SELECT COUNT(*) AS n FROM query_log");
  const recall7d = count(
    "SELECT COUNT(*) AS n FROM query_log WHERE executed_at >= datetime('now', '-7 days')",
  );
  const distinctQueries = count("SELECT COUNT(DISTINCT query) AS n FROM query_log");
  const topTerms = (
    db
      .prepare(
        `SELECT query, COUNT(*) AS n FROM query_log
         GROUP BY query ORDER BY n DESC, query ASC LIMIT 5`,
      )
      .all() as { query: string; n: number }[]
  ).map((r) => ({ query: r.query, count: Number(r.n) }));

  return {
    sessions,
    messages,
    toolUses: count("SELECT COUNT(*) AS n FROM tool_uses"),
    pendingOpen: count("SELECT COUNT(*) AS n FROM pending_actions WHERE status = 'open'"),
    dbPath,
    sizeBytes,
    byHarness,
    tokens: {
      ...summary,
      perSession: sessions > 0 ? Math.round(summary.totalTokens / sessions) : 0,
      perMessage: messages > 0 ? Math.round(summary.totalTokens / messages) : 0,
      byModel,
    },
    recalls: {
      total: recallTotal,
      last7d: recall7d,
      distinctQueries,
      topTerms,
    },
    sessionsBreakdown: {
      logical: count("SELECT COUNT(*) AS n FROM sessions WHERE is_agent_sidechain = 0"),
      sidechain: count("SELECT COUNT(*) AS n FROM sessions WHERE is_agent_sidechain = 1"),
      filesIndexed: count("SELECT COUNT(*) AS n FROM file_index"),
    },
  };
}

/** Per-day message counts (oldest→newest) over the last `days` days — sparkline feed. */
export function dailyActivity(db: DatabaseSync, days = 90): { day: string; count: number }[] {
  return db
    .prepare(
      `SELECT DATE(timestamp) AS day, COUNT(*) AS count
       FROM messages
       WHERE timestamp IS NOT NULL AND DATE(timestamp) >= DATE('now', ?)
       GROUP BY day ORDER BY day ASC`,
    )
    .all(`-${days} days`) as { day: string; count: number }[];
}
