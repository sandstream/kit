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
import { createHash } from "node:crypto";
import type { MemoryStats, MessageInput, SearchHit, SessionInput, ToolUseInput } from "./types.js";
import { summarizeTokens } from "./stats.js";
import { redactSecrets } from "../utils/redactSecrets.js";
import { secureFile, secureDir } from "../utils/secure-perms.js";
import { findInjection } from "./injection.js";
import { evaluateWriteGate, writeGateEnforcing, type WriteGateVerdict } from "./write-gate.js";

export const SCHEMA_VERSION = 8;

/** True when text carries a HIGH-confidence prompt-injection pattern — used to
 *  quarantine a message on insert so recall never re-injects it into the prompt. */
function isHighConfidenceInjection(text: string | null | undefined): boolean {
  if (!text) return false;
  return findInjection(text).some((f) => f.confidence === "high");
}

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

export function ensureMemoryDir(): void {
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
  version TEXT,
  quarantined INTEGER NOT NULL DEFAULT 0
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

CREATE TABLE IF NOT EXISTS memory_tombstones (
  uuid TEXT PRIMARY KEY,
  content_sha256 TEXT NOT NULL,
  session_id TEXT,
  reason TEXT,
  deleted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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
  // v5: device-couple PAL so an item created in an ephemeral session/container
  // doesn't nag on your durable device. origin_device = where it was created;
  // origin_root = the absolute project path (for `pal prune` of dead dirs). Older
  // rows have NULL → treated as "this device" (always shown), backward-compatible.
  ensureColumn(db, "pending_actions", "origin_device", "TEXT");
  ensureColumn(db, "pending_actions", "origin_root", "TEXT");
  // v6: atomic PAL claiming for parallel agents (from guild's Quests). A claim is
  // an `UPDATE … WHERE status='open'` guard so exactly one agent wins an open
  // item; claimed_by = the winner's id, claimed_at = when. Older rows have NULL
  // (unclaimed) → backward-compatible.
  ensureColumn(db, "pending_actions", "claimed_by", "TEXT");
  ensureColumn(db, "pending_actions", "claimed_at", "TEXT");
  // v7: quarantine a message carrying a high-confidence prompt-injection pattern so
  // recall (searchMessages / recentMessages) never re-injects it into the prompt.
  // Set on insert going forward; `kit memory scan --injection --quarantine` backfills
  // rows indexed before this. Older rows default 0 (shown) → backward-compatible.
  ensureColumn(db, "messages", "quarantined", "INTEGER NOT NULL DEFAULT 0");
  // v8: verified-forget (G1) — memory_tombstones records that a row was deleted
  // (uuid + content SHA-256, never the content itself) so "forgotten" is a checkable,
  // durable claim. The table is created by SCHEMA_SQL above (CREATE IF NOT EXISTS),
  // so existing stores gain it on next open; no column migration needed.
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
    } catch (err) {
      // ENOTSUP/ENOSYS/EPERM on exotic/non-POSIX filesystems are expected — chmod
      // simply isn't supported there, so stay quiet. ANY other failure means the
      // secret-dense store may be world-readable — surface it, don't leak silently.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOTSUP" && code !== "ENOSYS" && code !== "EPERM") {
        console.error(
          `kit: could not restrict permissions on ${dbPath} (${code ?? (err as Error).message}) — the memory store may be readable by other users`,
        );
      }
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

/** Insert a message idempotently (by uuid). Returns true if a new row was added.
 *  Returns false when the row already exists OR the capture-time write-gate (G1)
 *  rejects it (schema-invalid always; injection/oversize under KIT_MEMORY_WRITE_ENFORCE). */
export function insertMessage(db: DatabaseSync, m: MessageInput): boolean {
  const content = captureText(m.content);
  // Capture-time WRITE-GATE (G1): authorize the row BEFORE it lands. Fail closed
  // toward the prompt — any unexpected gate error quarantines (warn) or rejects
  // (enforce), never silently allows. A "quarantine" verdict preserves kit's prior
  // behavior exactly (stored, excluded from recall) so enabling the gate is a no-op
  // in warn mode; a "reject" verdict means the poisoned/malformed row never persists.
  let verdict: WriteGateVerdict;
  try {
    verdict = evaluateWriteGate(m, content);
  } catch {
    verdict = {
      decision: writeGateEnforcing() ? "reject" : "quarantine",
      reasons: [{ code: "schema", detail: "write-gate evaluation error" }],
    };
  }
  if (verdict.decision === "reject") return false;
  const quarantined = verdict.decision === "quarantine" ? 1 : 0;
  const res = db
    .prepare(
      `INSERT OR IGNORE INTO messages
       (uuid, session_id, parent_uuid, type, role, content, model, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, timestamp, cwd, git_branch, version, quarantined)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      m.uuid,
      m.sessionId,
      m.parentUuid ?? null,
      m.type,
      m.role ?? null,
      content,
      m.model ?? null,
      m.inputTokens ?? null,
      m.outputTokens ?? null,
      m.cacheReadTokens ?? null,
      m.cacheCreationTokens ?? null,
      m.timestamp ?? null,
      m.cwd ?? null,
      m.gitBranch ?? null,
      m.version ?? null,
      quarantined,
    );
  if (Number(res.changes) > 0) {
    db.prepare("UPDATE sessions SET message_count = message_count + 1 WHERE session_id = ?").run(
      m.sessionId,
    );
    return true;
  }
  return false;
}

/**
 * Proof that a memory row was forgotten. Every field is a checked fact, not an
 * assumption — `ok` is the conjunction the caller should gate on.
 */
export interface ForgetProof {
  uuid: string;
  /** Was a row with this uuid present before the delete? */
  found: boolean;
  /** SHA-256 of the deleted content (empty if not found) — the durable receipt. */
  contentSha256: string;
  /** The messages row with this uuid is absent after the delete. */
  rowGone: boolean;
  /** The FTS5 shadow index is consistent with the content table (no dangling entry). */
  ftsConsistent: boolean;
  /** A tombstone recording the deletion was written. */
  tombstoned: boolean;
  /** All of the above — a verified forget. */
  ok: boolean;
}

/**
 * VERIFIED-FORGET (G1): hard-delete a memory row and PROVE it is gone.
 *
 * The gap analysis (§2.1, verified 3-0) found post-deletion verification is an
 * industry-wide blind spot: systems delete but never check. This does the delete
 * inside a transaction (FTS is auto-purged by the messages_ad trigger), records a
 * content-hash tombstone (never the content — the store is secret-dense), then
 * READS BACK three independent facts: the row is absent, the FTS index is
 * internally consistent (integrity-check), and the tombstone exists. It fails
 * CLOSED — any check that can't confirm leaves `ok:false` rather than claiming
 * success. Deterministic, zero-LLM.
 *
 * Returns `found:false` (with `ok:false`) when no such row exists.
 */
export function forgetMemory(db: DatabaseSync, uuid: string, reason?: string): ForgetProof {
  const empty: ForgetProof = {
    uuid,
    found: false,
    contentSha256: "",
    rowGone: false,
    ftsConsistent: false,
    tombstoned: false,
    ok: false,
  };
  const existing = db
    .prepare("SELECT id, session_id, content FROM messages WHERE uuid = ?")
    .get(uuid) as { id: number; session_id: string; content: string | null } | undefined;
  if (!existing) return empty;

  const contentSha256 = createHash("sha256")
    .update(existing.content ?? "", "utf8")
    .digest("hex");

  // Delete + tombstone + message_count fixup atomically. The messages_ad trigger
  // removes the FTS shadow row in the same transaction.
  const tx = db.prepare("BEGIN");
  tx.run();
  try {
    db.prepare("DELETE FROM messages WHERE uuid = ?").run(uuid);
    db.prepare(
      "UPDATE sessions SET message_count = MAX(message_count - 1, 0) WHERE session_id = ?",
    ).run(existing.session_id);
    db.prepare(
      `INSERT INTO memory_tombstones (uuid, content_sha256, session_id, reason)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(uuid) DO UPDATE SET
         content_sha256 = excluded.content_sha256,
         deleted_at = CURRENT_TIMESTAMP,
         reason = excluded.reason`,
    ).run(uuid, contentSha256, existing.session_id, reason ?? null);
    db.prepare("COMMIT").run();
  } catch (err) {
    try {
      db.prepare("ROLLBACK").run();
    } catch {
      /* rollback best-effort */
    }
    throw err;
  }

  // Read back three independent proofs — fail closed on each.
  const rowGone =
    (db.prepare("SELECT COUNT(*) c FROM messages WHERE uuid = ?").get(uuid) as { c: number }).c ===
    0;
  const tombstoned =
    (
      db.prepare("SELECT COUNT(*) c FROM memory_tombstones WHERE uuid = ?").get(uuid) as {
        c: number;
      }
    ).c === 1;
  // FTS5 'integrity-check' raises SQLITE_CORRUPT if the shadow index disagrees with
  // the content table — i.e. if a dangling entry for the deleted row survived. No
  // throw ⇒ the index is consistent and the deleted row's terms are truly gone.
  let ftsConsistent = false;
  try {
    db.prepare("INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')").run();
    ftsConsistent = true;
  } catch {
    ftsConsistent = false;
  }

  return {
    uuid,
    found: true,
    contentSha256,
    rowGone,
    ftsConsistent,
    tombstoned,
    ok: rowGone && ftsConsistent && tombstoned,
  };
}

/** Count recorded tombstones (verified-forget receipts). */
export function countTombstones(db: DatabaseSync): number {
  return (db.prepare("SELECT COUNT(*) c FROM memory_tombstones").get() as { c: number }).c;
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
  /** Include quarantined (high-confidence injection) rows. Default false: recall
   *  excludes them so a poisoned line is never re-injected. Set for inspection. */
  includeQuarantined?: boolean;
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
 * prefix-match it. `op` joins the terms: "AND" (implicit, the default — every
 * term must match) or "OR" (any term — the graceful-recall fallback, ranked by
 * bm25 so the message matching the most terms floats to the top). Returns "" for
 * an empty/whitespace query so the caller can short-circuit.
 */
export function toFtsMatchQuery(raw: string, op: "AND" | "OR" = "AND"): string {
  const terms = raw.trim().split(/\s+/).filter(Boolean);
  const quoted = terms.map((t) => `"${t.replace(/"/g, '""')}"*`);
  return quoted.join(op === "OR" ? " OR " : " ");
}

export function searchMessages(
  db: DatabaseSync,
  query: string,
  opts: SearchOptions = {},
): SearchHit[] {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const limit = opts.limit ?? 20;

  const run = (match: string): SearchHit[] => {
    const params: (string | number)[] = [match];
    let where = "messages_fts MATCH ?";
    if (!opts.includeQuarantined) where += " AND m.quarantined = 0";
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
  };

  // Precision first: an all-terms (implicit-AND) match. FTS5's `rank` is bm25,
  // so results already come back relevance-ordered.
  const strict = run(toFtsMatchQuery(query, "AND"));
  if (strict.length > 0 || terms.length < 2) return strict;

  // Graceful recall: a strict AND over a multi-term query returned nothing (no
  // single message holds every term). Fall back to OR so partial matches still
  // surface, bm25-ranked — the message covering the most terms ranks first.
  // This is the "rank by relevance, not all-or-nothing" behavior (#164).
  return run(toFtsMatchQuery(query, "OR"));
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
  if (!opts.includeQuarantined) where += " AND quarantined = 0";
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

/**
 * Backfill quarantine: mark every message whose content carries a high-confidence
 * injection pattern but isn't yet quarantined — rows indexed before v7 / before the
 * insert-time gate. Returns the count newly quarantined. Detection is JS-side
 * (findInjection), so we iterate the un-quarantined rows. Deterministic, zero-LLM.
 */
export function quarantineInjectedMessages(db: DatabaseSync): number {
  const rows = db
    .prepare("SELECT id, content FROM messages WHERE quarantined = 0 AND content IS NOT NULL")
    .all() as { id: number; content: string }[];
  const mark = db.prepare("UPDATE messages SET quarantined = 1 WHERE id = ?");
  let n = 0;
  for (const r of rows) {
    if (isHighConfidenceInjection(r.content)) {
      mark.run(r.id);
      n++;
    }
  }
  return n;
}

/** How many messages are currently quarantined (excluded from recall by default). */
export function countQuarantined(db: DatabaseSync): number {
  const r = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE quarantined = 1").get() as
    | { n: number }
    | undefined;
  return r ? Number(r.n) : 0;
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
  // Recall adoption: recalls in the last 7d over sessions active in the last 7d.
  // query_log has no session_id, so this is a per-active-session rate (near 0 ⇒
  // the agent is ignoring the "run kit memory search" nudge), not a
  // distinct-sessions-with-recall count. Honest, deterministic, no schema change.
  const activeSessions7d = count(
    "SELECT COUNT(*) AS n FROM sessions WHERE last_message_at >= datetime('now', '-7 days')",
  );
  const perActiveSession7d =
    activeSessions7d > 0 ? Math.round((recall7d / activeSessions7d) * 10) / 10 : 0;
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
      activeSessions7d,
      perActiveSession7d,
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
