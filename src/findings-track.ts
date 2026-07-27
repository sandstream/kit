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
 * Out-of-verdict advisories carried by results of ANY status — including `pass`, which
 * is where they mostly live, since an advisory that moved the verdict would make the
 * gate depend on the wall clock or on someone else's release schedule. That is exactly
 * why `actionableFindings` cannot see them: it filters on fail/warn.
 */
export function advisoryFindings(results: SecurityCheckResult[]): SyncFinding[] {
  return results
    .filter(
      (r): r is SecurityCheckResult & { advisory: NonNullable<SecurityCheckResult["advisory"]> } =>
        r.advisory !== undefined,
    ) // prettier-ignore
    .map((r) => ({
      dedupKey: r.advisory.key,
      title: r.advisory.title,
      detail: r.advisory.detail,
    }));
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
    // Scope by the ABSOLUTE project root, not its basename: two different repos
    // that happen to share a directory name (e.g. ~/work/api and ~/scratch/api)
    // must not reconcile into each other's findings.
    const scope = getCurrentProjectRoot();
    const db = openMemoryDb();
    try {
      const r = palSyncFindings(db, "sec", actionableFindings(results).map(securityFindingToSync), {
        scope,
      });
      // Advisories reconcile under their OWN source tag. palSyncFindings closes every
      // row of its tag that is absent from the batch, so folding advisories into "sec"
      // would make each sync close the other's items on every run.
      const a = palSyncFindings(db, "adv", advisoryFindings(results), { scope });
      return {
        added: r.added + a.added,
        reopened: r.reopened + a.reopened,
        closed: [...r.closed, ...a.closed],
      };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}
