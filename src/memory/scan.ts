/**
 * kit memory — secret scan over the store.
 *
 * The memory DB is secret-dense (it indexes raw transcripts). gitleaks and most
 * scanners only see text files, not SQLite cell contents — so this scans the
 * text columns directly, reusing kit's SECRET_PATTERNS via findSecrets (DRY).
 * Findings are MASKED (label + short preview), never the raw secret.
 */
import type { DatabaseSync } from "node:sqlite";
import { findSecrets } from "../utils/redactSecrets.js";

export interface ScanHit {
  table: string;
  id: number | string;
  column: string;
  label: string;
  preview: string;
}

const TARGETS: { table: string; idCol: string; columns: string[] }[] = [
  { table: "messages", idCol: "id", columns: ["content"] },
  { table: "tool_uses", idCol: "id", columns: ["tool_input"] },
  { table: "pending_actions", idCol: "id", columns: ["title", "detail", "verify_cmd"] },
  { table: "saved_threads", idCol: "name", columns: ["summary"] },
];

/** Scan every text cell for stored secrets. Returns masked findings (empty = clean). */
export function scanDbForSecrets(db: DatabaseSync): ScanHit[] {
  const hits: ScanHit[] = [];
  for (const target of TARGETS) {
    const cols = [target.idCol, ...target.columns].join(", ");
    const rows = db.prepare(`SELECT ${cols} FROM ${target.table}`).all() as Record<
      string,
      unknown
    >[];
    for (const row of rows) {
      for (const col of target.columns) {
        const val = row[col];
        if (typeof val !== "string" || !val) continue;
        for (const finding of findSecrets(val)) {
          hits.push({
            table: target.table,
            id: row[target.idCol] as number | string,
            column: col,
            label: finding.label,
            preview: finding.preview,
          });
        }
      }
    }
  }
  return hits;
}
