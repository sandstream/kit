/**
 * External-findings ingestion — the inbound contract that lets ANY third-party
 * security tool (a kit-plugin like snyk/wiz/sentrux, or any partner scanner) fold
 * its results into `kit check`'s verdict without kit knowing that tool.
 *
 * Contract: a tool appends one JSON object per line to `.kit-scan-results.jsonl`
 * in the project root. kit reads it deterministically and turns each `source` into
 * a SecurityCheckResult. This is how "connect to kit" works — partners emit the
 * shape; kit ingests it; there is no per-partner code in kit's core.
 *
 * Minimal line shape (extra keys ignored):
 *   {"source":"snyk","severity":"high","id":"SNYK-JS-…","title":"…","package":"lodash"}
 * `source` (non-empty string) and `severity` (critical|high|medium|low) are required.
 *
 * SECURITY / no-false-green: ingestion can only ADD findings (escalate the verdict),
 * never remove or downgrade a kit finding, and it NEVER emits a `pass` — so a
 * garbage or hostile file cannot turn the gate green. A high/critical finding FAILS
 * the gate (like npm audit); medium/low only WARN. Unparseable lines are skipped but
 * COUNTED and surfaced (no silent drop). Deterministic, zero-LLM.
 *
 * Freshness is the EMITTER's responsibility: a tool should rewrite (or dedupe) its
 * findings per scan, not blindly append forever, or stale findings will keep failing
 * the gate. kit ingests what the file says — it does not second-guess it.
 */
import { resolve } from "node:path";
import type { SecurityCheckResult } from "./check-security.js";

/** The de-facto sink kit-plugin-snyk/wiz/sentrux already append to. */
export const EXTERNAL_FINDINGS_FILE = ".kit-scan-results.jsonl";

export type ExternalSeverity = "critical" | "high" | "medium" | "low";

export interface ExternalFinding {
  source: string;
  severity: ExternalSeverity;
  title?: string;
  id?: string;
  package?: string;
}

export interface ParsedExternalFindings {
  findings: ExternalFinding[];
  /** Non-empty lines that were not a usable finding object (surfaced, never silent). */
  malformed: number;
}

const RANK: Record<ExternalSeverity, number> = { critical: 3, high: 2, medium: 1, low: 0 };

/**
 * Map a raw severity string to one of kit's four tiers. Liberal in what we accept
 * (Postel) so a real scanner's native vocabulary ingests cleanly instead of parse-
 * erroring: an `info`/`informational` tier (e.g. wiz) folds to `low` (warns, never
 * fails), and `moderate` (npm/GitHub advisories) folds to `medium`. Anything
 * unrecognized returns null → the caller counts it as malformed (surfaced, not silent).
 */
function normalizeSeverity(raw: string): ExternalSeverity | null {
  switch (raw.trim().toLowerCase()) {
    case "critical":
      return "critical";
    case "high":
      return "high";
    case "medium":
    case "moderate":
      return "medium";
    case "low":
    case "info":
    case "informational":
      return "low";
    default:
      return null;
  }
}

/**
 * Parse `.kit-scan-results.jsonl` content. PURE and fail-safe: never throws; a line
 * that isn't valid JSON, isn't an object, or lacks a `source`/valid `severity` is
 * counted as `malformed` — never dropped silently and never turned into a finding.
 */
export function parseExternalFindings(text: string): ParsedExternalFindings {
  const findings: ExternalFinding[] = [];
  let malformed = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      malformed++;
      continue;
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
      malformed++;
      continue;
    }
    const o = obj as Record<string, unknown>;
    const source = typeof o.source === "string" ? o.source.trim() : "";
    const severity = typeof o.severity === "string" ? normalizeSeverity(o.severity) : null;
    if (!source || !severity) {
      malformed++;
      continue;
    }
    findings.push({
      source,
      severity,
      title: typeof o.title === "string" ? o.title : undefined,
      id: typeof o.id === "string" ? o.id : undefined,
      package: typeof o.package === "string" ? o.package : undefined,
    });
  }
  return { findings, malformed };
}

/**
 * Turn parsed external findings into per-source SecurityCheckResults. PURE. A source
 * with any critical/high finding FAILS; only medium/low WARNs. Never emits `pass` —
 * ingestion can escalate the verdict, never green it. Sources are sorted for a
 * deterministic order; malformed lines yield one low-severity warn.
 */
export function externalFindingResults(parsed: ParsedExternalFindings): SecurityCheckResult[] {
  const bySource = new Map<string, ExternalFinding[]>();
  for (const f of parsed.findings) {
    const arr = bySource.get(f.source) ?? [];
    arr.push(f);
    bySource.set(f.source, arr);
  }
  const out: SecurityCheckResult[] = [];
  for (const [source, fs] of [...bySource.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const counts: Record<ExternalSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
    let worst: ExternalSeverity = "low";
    for (const f of fs) {
      counts[f.severity]++;
      if (RANK[f.severity] > RANK[worst]) worst = f.severity;
    }
    const blocking = counts.critical > 0 || counts.high > 0;
    const summary = (["critical", "high", "medium", "low"] as ExternalSeverity[])
      .filter((s) => counts[s] > 0)
      .map((s) => `${counts[s]} ${s}`)
      .join(", ");
    out.push({
      category: "supply-chain",
      name: `external: ${source}`,
      status: blocking ? "fail" : "warn",
      detail: `${fs.length} finding(s) from ${source} (${summary})`,
      severity: worst,
    });
  }
  if (parsed.malformed > 0) {
    out.push({
      category: "supply-chain",
      name: "external findings (parse)",
      status: "warn",
      detail: `${parsed.malformed} unparseable line(s) in ${EXTERNAL_FINDINGS_FILE} — ignored (fix the emitting tool)`,
      severity: "low",
    });
  }
  return out;
}

/**
 * Read + ingest `.kit-scan-results.jsonl` for `kit check`. No file → [] (no-op, so
 * this is invisible unless a partner tool has emitted findings). IO wrapper around
 * the two pure functions above.
 */
export async function checkExternalFindings(
  cwd: string = process.cwd(),
): Promise<SecurityCheckResult[]> {
  const { readFile } = await import("node:fs/promises");
  let text: string;
  try {
    text = await readFile(resolve(cwd, EXTERNAL_FINDINGS_FILE), "utf-8");
  } catch {
    return []; // no external results → nothing ingested
  }
  return externalFindingResults(parseExternalFindings(text));
}
