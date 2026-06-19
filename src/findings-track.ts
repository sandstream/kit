/**
 * Bridge between security findings and the PAL ledger. Shared by `kit check`
 * (tracks findings each run) and `kit heal` (re-scans + confirms healing via
 * auto-close). Kept separate so neither command owns the mapping.
 */
import type { SecurityCheckResult } from "./check-security.js";
import type { SyncFinding } from "./memory/pal.js";

const TRACK_WARN = new Set(["secrets", "exposure", "supply-chain"]);

/** Findings worth acting on: fails always, warns only in security-relevant
 *  categories (not every warn — avoids ledger/heal noise). */
export function actionableFindings(results: SecurityCheckResult[]): SecurityCheckResult[] {
  return results.filter(
    (r) => r.status === "fail" || (r.status === "warn" && TRACK_WARN.has(r.category)),
  );
}

/** Map a security finding to a short, actionable PAL item. `dedupKey` is stable
 *  across re-scans so the same finding maps to the same ledger row. */
export function securityFindingToSync(r: SecurityCheckResult): SyncFinding {
  const detail = [r.detail, r.suggestion ? `Fix: ${r.suggestion}` : null]
    .filter(Boolean)
    .join(" · ");
  return {
    dedupKey: `${r.category}:${r.name}`,
    title: `${r.name}: ${r.status}`,
    detail: detail || undefined,
  };
}

/**
 * Sync security findings into the PAL ledger (track + auto-close cleared ones).
 * Fail-open: returns the sync counts, or null if the store is unavailable —
 * tracking must never break the calling command.
 */
export async function syncSecurityFindings(
  results: SecurityCheckResult[],
): Promise<{ added: number; reopened: number; closed: string[] } | null> {
  try {
    const { openMemoryDb } = await import("./memory/db.js");
    const { palSyncFindings } = await import("./memory/pal.js");
    const { getCurrentProjectRoot } = await import("./memory/project.js");
    const { basename } = await import("node:path");
    const scope = basename(getCurrentProjectRoot());
    const db = openMemoryDb();
    try {
      return palSyncFindings(db, "sec", actionableFindings(results).map(securityFindingToSync), {
        scope,
      });
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}
