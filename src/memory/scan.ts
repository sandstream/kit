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

/**
 * Walk every text cell across TARGETS, apply `finder`, and return findings deduped
 * by (label, preview) with an occurrence count, confidence tier, one sample
 * location, and the project(s) they appear in. Shared by the secret and injection
 * scans so they stay byte-for-byte consistent in shape and ordering.
 */
function scanDbWith(db: DatabaseSync, finder: CellFinder): ScanFinding[] {
  const byKey = new Map<string, ScanFinding & { _projects: Set<string> }>();
  for (const target of TARGETS) {
    const rows = db.prepare(target.select).all() as Record<string, unknown>[];
    for (const row of rows) {
      const proj = projectName(row.__project);
      for (const col of target.columns) {
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
              sample: `${target.table}#${row[target.idCol]}.${col}`,
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
  }
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
