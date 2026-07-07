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

interface Target {
  table: string;
  idCol: string;
  columns: string[];
  /** Returns idCol, the text columns, and a `__project` hint (cwd / scope / path). */
  select: string;
}

const TARGETS: Target[] = [
  {
    table: "messages",
    idCol: "id",
    columns: ["content"],
    select: "SELECT id, content, cwd AS __project FROM messages",
  },
  {
    table: "tool_uses",
    idCol: "id",
    columns: ["tool_input"],
    select:
      "SELECT tool_uses.id AS id, tool_uses.tool_input AS tool_input, m.cwd AS __project " +
      "FROM tool_uses LEFT JOIN messages m ON m.uuid = tool_uses.message_uuid",
  },
  {
    table: "pending_actions",
    idCol: "id",
    columns: ["title", "detail", "verify_cmd"],
    select: "SELECT id, title, detail, verify_cmd, scope AS __project FROM pending_actions",
  },
  {
    table: "saved_threads",
    idCol: "name",
    columns: ["summary"],
    select: "SELECT name, summary, project_path AS __project FROM saved_threads",
  },
];

// Heuristic labels are pattern-based guesses (KEY=value, tfstate blobs) that
// frequently match benign env vars / file paths. Everything else is a structured,
// high-confidence credential pattern.
const HEURISTIC_LABELS = new Set(["kv-secret", "tfstate-value"]);

function projectName(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw) return null;
  return raw.includes("/") ? basename(raw) : raw;
}

/** A per-cell finder: given text, return masked, confidence-tiered matches. */
type CellFinder = (
  text: string,
) => { label: string; preview: string; confidence: ScanConfidence }[];

type FindingEntry = ScanFinding & { _projects: Set<string> };

/** Column names present in `table` (empty set if the table is absent). The table
 *  name is a hardcoded TARGETS constant — never user input — so interpolation is safe. */
function tableColumns(db: DatabaseSync, table: string): Set<string> {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    return new Set(rows.map((r) => r.name));
  } catch {
    return new Set();
  }
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
): void {
  const proj = projectName(row.__project);
  for (const col of columns) {
    const val = row[col];
    if (typeof val !== "string" || !val) continue;
    for (const f of finder(val)) {
      const key = `${f.label} ${f.preview}`;
      let entry = byKey.get(key);
      if (!entry) {
        entry = {
          label: f.label,
          preview: f.preview,
          confidence: f.confidence,
          count: 0,
          sample: `${table}#${row[idKey]}.${col}`,
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
 * If that throws — a crafted or older store missing an auxiliary column such as
 * `messages.cwd` — we do NOT skip the whole target. That was the R7 bypass: drop
 * `cwd` and the rich SELECT throws, so the payload column `content` in the SAME
 * target went unscanned and rode the merge in. Instead we fall back to scanning
 * each text column that ACTUALLY exists, so a payload in any present column is
 * always caught; only the (cosmetic) project attribution is dropped.
 */
function scanTarget(
  db: DatabaseSync,
  target: Target,
  finder: CellFinder,
  byKey: Map<string, FindingEntry>,
): void {
  try {
    for (const row of db.prepare(target.select).all() as Record<string, unknown>[]) {
      foldRow(row, target.columns, target.idCol, target.table, finder, byKey);
    }
    return;
  } catch {
    // Rich SELECT failed (missing hint column / join / table) → resilient fallback.
  }
  const cols = tableColumns(db, target.table);
  if (cols.size === 0) return; // table genuinely absent → nothing here to scan
  const idExpr = cols.has(target.idCol) ? target.idCol : "rowid";
  for (const col of target.columns) {
    if (!cols.has(col)) continue;
    try {
      const rows = db
        .prepare(`SELECT ${idExpr} AS __id, ${col} FROM ${target.table}`)
        .all() as Record<string, unknown>[];
      for (const row of rows) foldRow(row, [col], "__id", target.table, finder, byKey);
    } catch {
      // this column is genuinely unreadable → skip just it, keep scanning the rest
    }
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
function scanDbWith(db: DatabaseSync, finder: CellFinder): ScanFinding[] {
  const byKey = new Map<string, FindingEntry>();
  for (const target of TARGETS) scanTarget(db, target, finder, byKey);
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
export function scanDbForInjection(db: DatabaseSync): ScanFinding[] {
  return scanDbWith(db, (text) => findInjection(text));
}

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
