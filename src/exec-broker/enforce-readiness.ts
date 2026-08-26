/**
 * exec-broker — observe→enforce readiness (E1, pure core).
 * The observe (dry-run) rung of the Pillar 3 ladder records, per operation, the denials that
 * enforce mode WOULD apply — an audit event with `metadata.phase === "observe"` and
 * `metadata.wouldDeny: string[]` (empty ⇒ the op would pass under enforce). This module reads
 * that recorded evidence and answers the one question that blocks adoption: **is it safe to
 * flip to enforce, and if not, exactly what would break?** Turning the flip from a leap into a
 * diff.
 *
 * Pure + tolerant: a missing file is "untested", a malformed line is skipped (never thrown).
 * Deterministic, zero-LLM. Honest floor: no observe data is `untested`, never a green "ready".
 */

/** One observed operation's would-be denials (empty ⇒ it would pass under enforce). */
export interface ObserveRecord {
  wouldDeny: string[];
}

export type EnforceVerdict =
  | "ready" // ops observed, none would be denied → safe to flip
  | "would-block" // at least one observed op would be denied under enforce
  | "untested"; // no observe data — cannot claim ready

export interface EnforceReadiness {
  opsObserved: number;
  /** Observed ops with ≥1 would-be denial (these break on flip unless the scope is widened). */
  wouldBlockOps: number;
  /** Distinct would-be-denial reasons, most frequent first (verbatim — no fragile target parsing). */
  reasons: { reason: string; count: number }[];
  verdict: EnforceVerdict;
}

/**
 * Extract observe records from raw `.kit-audit.jsonl` content: audit lines whose
 * `metadata.phase === "observe"`, taking `metadata.wouldDeny` (a string[]) as the would-be
 * denials. Tolerant — blank/malformed lines and non-observe lines are skipped. Pure.
 */
export function parseObserveRecords(auditJsonl: string): ObserveRecord[] {
  const out: ObserveRecord[] = [];
  for (const line of auditJsonl.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    // Tolerant: a line that parses to null/number/array (not an object) is not an audit event.
    if (typeof parsed !== "object" || parsed === null) continue;
    const e = parsed as { metadata?: { phase?: unknown; wouldDeny?: unknown } };
    if (!e.metadata || e.metadata.phase !== "observe") continue;
    const raw = e.metadata.wouldDeny;
    const wouldDeny = Array.isArray(raw)
      ? raw.filter((r): r is string => typeof r === "string")
      : [];
    out.push({ wouldDeny });
  }
  return out;
}

/**
 * Fold observe records into an enforce-readiness verdict. No records ⇒ `untested` (never a
 * green pass — coverage is only what was observed). Any op with a would-be denial ⇒
 * `would-block` (flipping breaks it unless the scope is widened first); otherwise `ready`.
 * Reasons are tallied verbatim (deterministic; a would-block report lists exactly what breaks).
 * Pure.
 */
export function assessEnforceReadiness(records: ObserveRecord[]): EnforceReadiness {
  if (records.length === 0) {
    return { opsObserved: 0, wouldBlockOps: 0, reasons: [], verdict: "untested" };
  }
  let wouldBlockOps = 0;
  const counts = new Map<string, number>();
  for (const r of records) {
    if (r.wouldDeny.length > 0) wouldBlockOps++;
    for (const reason of r.wouldDeny) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  const reasons = [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0));
  return {
    opsObserved: records.length,
    wouldBlockOps,
    reasons,
    verdict: wouldBlockOps > 0 ? "would-block" : "ready",
  };
}
