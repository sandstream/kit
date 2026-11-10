/**
 * kit memory — secret scan over the store.
 *
 * The memory DB is secret-dense (it indexes raw transcripts). gitleaks and most
 * scanners only see text files, not SQLite cell contents — so this scans the text
 * columns directly, reusing kit's SECRET_PATTERNS via findSecrets (DRY). Findings
 * are MASKED (label + short preview), never the raw secret.
 *
 * Findings are DEDUPED by (label, preview) with an occurrence count, split by
 * CONFIDENCE so the genuinely dangerous keys (sk_live, AIzaSy, AKIA, ghp_, …) are
 * not buried under the over-eager `KEY=value` heuristic, and ATTRIBUTED to the
 * project(s) they leaked in (via each row's cwd) so you know which provider account
 * to rotate. Only high-confidence findings make `kit memory scan` exit non-zero.
 */
import { basename } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { sanitizeDisplayText } from "../display-text.js";
import { findSecrets } from "../utils/redactSecrets.js";
import { findInjection } from "./injection.js";

export type ScanConfidence = "high" | "heuristic";

export interface ScanFinding {
  label: string;
  preview: string;
  confidence: ScanConfidence;
  /** How many cells matched this (label, preview). */
  count: number;
  /** One example location, e.g. "messages#23839.content". */
  sample: string;
  /** Distinct project hints (which repo the secret leaked in), e.g. ["acme-app"]. */
  projects: string[];
}

export interface ScanOccurrence {
  table: string;
  id: unknown;
  label: string;
  confidence: ScanConfidence;
}
type OccurrenceObserver = (occurrence: ScanOccurrence) => void;

interface Target {
  table: string;
  idCol: string;
  columns: string[];
  /** Returns idCol, the text columns, and a `__project` hint (cwd / scope / path). */
  select: string;
}

const MESSAGE_CONTENT_TARGET: Target = {
  table: "messages",
  idCol: "id",
  columns: ["content"],
  select: "SELECT id, content, cwd AS __project FROM messages",
};

const TOOL_INPUT_TARGET: Target = {
  table: "tool_uses",
  idCol: "id",
  columns: ["tool_input"],
  select:
    "SELECT t.id, t.tool_input, m.cwd AS __project FROM tool_uses t LEFT JOIN messages m ON m.uuid = t.message_uuid",
};

const TARGETS: Target[] = [
  {
    table: "sessions",
    idCol: "id",
    // Session metadata can change the origin of existing, non-quarantined messages.
    columns: ["session_id", "harness", "project", "first_message_at", "last_message_at"],
    select:
      "SELECT id, session_id, harness, project, first_message_at, last_message_at, project AS __project FROM sessions",
  },
  MESSAGE_CONTENT_TARGET,
  {
    table: "messages",
    idCol: "id",
    // Recall, session selection and statistics expose these fields independently of content.
    columns: ["uuid", "session_id", "role", "model", "timestamp", "cwd", "git_branch"],
    select:
      "SELECT id, uuid, session_id, role, model, timestamp, cwd, git_branch, cwd AS __project FROM messages",
  },
  {
    table: "tool_uses",
    idCol: "id",
    // Runtime and usage reports expose these fields independently of archived inputs.
    columns: [
      "message_uuid",
      "session_id",
      "tool_name",
      "timestamp",
      "call_id",
      "outcome",
      "outcome_at",
    ],
    select:
      "SELECT t.id, t.message_uuid, t.session_id, t.tool_name, t.timestamp, t.call_id, t.outcome, t.outcome_at, m.cwd AS __project FROM tool_uses t LEFT JOIN messages m ON m.uuid = t.message_uuid",
  },
  TOOL_INPUT_TARGET,
  {
    table: "pending_actions",
    idCol: "id",
    columns: ["title", "detail", "verify_cmd", "verify_check", "verify_definition"],
    select:
      "SELECT id, title, detail, verify_cmd, verify_check, verify_definition, scope AS __project FROM pending_actions",
  },
  {
    table: "pal_revisions",
    idCol: "rev_id",
    columns: ["state_json", "actor_device"],
    select:
      "SELECT rev_id, state_json, actor_device, json_extract(state_json, '$.scope') AS __project FROM pal_revisions",
  },
  {
    table: "saved_threads",
    idCol: "name",
    // Thread readers expose every copied text field, including identifiers and dates.
    columns: ["name", "session_id", "summary", "project_path", "saved_at"],
    select:
      "SELECT name, session_id, summary, project_path, saved_at, project_path AS __project FROM saved_threads",
  },
];

// Heuristic labels are pattern-based guesses (KEY=value, tfstate blobs) that
// frequently match benign env vars / file paths. Everything else is a structured,
// high-confidence credential pattern.
const HEURISTIC_LABELS = new Set(["kv-secret", "tfstate-value"]);

function safeLocation(value: unknown): string {
  return sanitizeDisplayText(String(value));
}

function projectName(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw) return null;
  return safeLocation(raw.includes("/") ? basename(raw) : raw);
}

/** A per-cell finder: given text, return masked, confidence-tiered matches. */
type CellFinder = (
  text: string,
) => { label: string; preview: string; confidence: ScanConfidence }[];

type FindingEntry = ScanFinding & { _projects: Set<string> };

/** Column names present in `table` (empty set if the table is absent). The table
 *  name is a hardcoded TARGETS constant — never user input — so interpolation is safe. */
function tableColumns(db: DatabaseSync, table: string): Set<string> {
  // Include generated columns. Schema read errors must propagate to the import gate.
  const rows = db.prepare(`PRAGMA table_xinfo(${table})`).all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

/** Fold one result row's text cells into the dedup map. `idKey` names the id column
 *  in the row (for the sample location). */
function foldRow(
  row: Record<string, unknown>,
  columns: string[],
  idKey: string,
  table: string,
  finder: CellFinder,
  byKey: Map<string, FindingEntry>,
  observe?: OccurrenceObserver,
): void {
  const proj = projectName(row.__project);
  for (const col of columns) {
    const val = row[col];
    if (typeof val !== "string" || !val) continue;
    for (const f of finder(val)) {
      observe?.({ table, id: row[idKey], label: f.label, confidence: f.confidence });
      const key = `${f.label} ${f.preview}`;
      let entry = byKey.get(key);
      if (!entry) {
        entry = {
          label: f.label,
          preview: f.preview,
          confidence: f.confidence,
          count: 0,
          sample: `${table}#${safeLocation(row[idKey])}.${col}`,
          projects: [],
          _projects: new Set<string>(),
        };
        byKey.set(key, entry);
      }
      entry.count++;
      if (proj) entry._projects.add(proj);
    }
  }
}

/**
 * Scan one target. Fast path: the rich SELECT (with its project-hint join/column).
 * If that fails, scan each available text column without the auxiliary columns.
 * An absent identifier does not prevent a cell read, including in WITHOUT ROWID tables.
 * Only attribution is optional. Schema and cell read failures must propagate.
 */
function scanTarget(
  db: DatabaseSync,
  target: Target,
  finder: CellFinder,
  byKey: Map<string, FindingEntry>,
  observe?: OccurrenceObserver,
): void {
  let rows: Record<string, unknown>[] | undefined;
  try {
    rows = db.prepare(target.select).all();
  } catch {
    // Rich SELECT failed (missing hint column / join / table) → resilient fallback.
  }
  if (rows) {
    for (const row of rows)
      foldRow(row, target.columns, target.idCol, target.table, finder, byKey, observe);
    return;
  }
  const cols = tableColumns(db, target.table);
  if (cols.size === 0) return; // table genuinely absent → nothing here to scan
  // A missing identifier affects attribution, never whether a cell is scanned.
  const idExpr = cols.has(target.idCol) ? target.idCol : "NULL";
  for (const col of target.columns) {
    if (!cols.has(col)) continue;
    const cells = db.prepare(`SELECT ${idExpr} AS __id, ${col} FROM ${target.table}`).all();
    for (const row of cells) foldRow(row, [col], "__id", target.table, finder, byKey, observe);
  }
}

/**
 * Walk every text cell across TARGETS, apply `finder`, and return findings deduped
 * by (label, preview) with an occurrence count, confidence tier, one sample
 * location, and the project(s) they appear in. Shared by the secret and injection
 * scans so they stay byte-for-byte consistent in shape and ordering. Resilient to a
 * partial/adversarial schema (see scanTarget) — a missing auxiliary column can no
 * longer suppress scanning of a present payload column.
 */
function scanDbWith(
  db: DatabaseSync,
  finder: CellFinder,
  observe?: OccurrenceObserver,
  targets: Target[] = TARGETS,
): ScanFinding[] {
  const byKey = new Map<string, FindingEntry>();
  for (const target of targets) scanTarget(db, target, finder, byKey, observe);
  return [...byKey.values()]
    .map(({ _projects, ...f }) => ({ ...f, projects: [..._projects].sort() }))
    .sort((a, b) => {
      if (a.confidence !== b.confidence) return a.confidence === "high" ? -1 : 1;
      return b.count - a.count;
    });
}

/** Scan every text cell for stored secrets. Deduped, confidence-tiered, project-attributed. */
export function scanDbForSecrets(db: DatabaseSync): ScanFinding[] {
  return scanDbWith(db, (text) =>
    findSecrets(text).map((f) => ({
      label: f.label,
      preview: f.preview,
      confidence: HEURISTIC_LABELS.has(f.label) ? "heuristic" : "high",
    })),
  );
}

/**
 * Scan every text cell for prompt-injection patterns (the store is replayed into
 * the agent's prompt, so a poisoned entry is a delayed injection vector). Same
 * shape as the secret scan — deduped, confidence-tiered, project-attributed.
 */
export function scanDbForInjection(
  db: DatabaseSync,
  observe?: OccurrenceObserver,
  opts: { replayableOnly?: boolean } = {},
): ScanFinding[] {
  return scanDbWith(
    db,
    (text) => findInjection(text),
    observe,
    opts.replayableOnly ? REPLAYABLE_TARGETS : TARGETS,
  );
}

/**
 * Only message content receives the authenticated quarantine exemption. Session metadata can
 * change an existing message's origin. Lists and statistics also expose metadata from quarantined
 * messages. Tool inputs remain archive evidence; recall does not read them.
 * If the content SELECT lacks a required column, the fallback scans all available content.
 */
const REPLAYABLE_TARGETS: Target[] = TARGETS.filter((t) => t !== TOOL_INPUT_TARGET).map((t) =>
  t === MESSAGE_CONTENT_TARGET ? { ...t, select: `${t.select} WHERE quarantined = 0` } : t,
);

/**
 * Count the messages that would actually be REPLAYED into a prompt (quarantined = 0)
 * yet carry a HIGH-confidence injection pattern — the rows `kit check` must fail on.
 * Quarantined rows are already excluded from recall (mitigated), so they don't count;
 * a non-quarantined high-confidence row is a live vector (e.g. indexed before the
 * insert-time quarantine gate existed). Returns the count plus one sample location.
 * Throws if the store schema can't be queried — the caller turns that into a
 * fail-closed scanner-health result (never a silent pass).
 */
export function replayableInjectionCount(db: DatabaseSync): {
  count: number;
  sample?: string;
  scanned: number;
} {
  const rows = db
    .prepare(
      "SELECT rowid AS rowid, content FROM messages WHERE quarantined = 0 AND content IS NOT NULL AND content != ''",
    )
    .all() as { rowid: number; content: string }[];
  let count = 0;
  let sample: string | undefined;
  for (const r of rows) {
    if (findInjection(r.content).some((f) => f.confidence === "high")) {
      count++;
      sample ??= `messages#${r.rowid}`;
    }
  }
  // `scanned` = recallable (non-quarantined, non-empty) rows actually examined. Lets
  // callers treat an EMPTY store the same as an ABSENT one, so `kit check` doesn't flip
  // skip→pass once a run materializes an empty memory.db.
  return { count, sample, scanned: rows.length };
}
