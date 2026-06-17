/**
 * Semgrep ingestion — wrap, don't rebuild.
 *
 * kit does not implement SAST; Semgrep (and Snyk, etc.) do that well. This module
 * runs Semgrep when it is present, parses its JSON output, and normalizes each
 * finding into kit's finding + citation shape so `kit security semgrep` (and, later,
 * `kit review`) can show one consolidated, cited, fix-oriented report. Semgrep
 * findings already carry a rule id and CWE/OWASP metadata, so the citation comes
 * almost for free.
 */
import { execFileNoThrow } from "./utils/execFileNoThrow.js";
import type { RuleRef } from "./rules/catalog.js";

export interface SemgrepFinding {
  ruleId: string;
  message: string;
  file: string;
  line: number | null;
  severity: "error" | "warning" | "info";
  /** Citation derived from Semgrep's own metadata (CWE preferred, else OWASP). */
  rule: RuleRef | null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

function firstString(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  return null;
}

/** Build a RuleRef from a Semgrep `extra.metadata` block (cwe / owasp). PURE. */
export function citationFromMetadata(metadata: unknown): RuleRef | null {
  const meta = asRecord(metadata);
  if (!meta) return null;

  const cwe = firstString(meta.cwe);
  if (cwe) {
    const m = cwe.match(/CWE-(\d+)/i);
    if (m) {
      return {
        id: `CWE-${m[1]}`,
        source: "cwe",
        ref: `https://cwe.mitre.org/data/definitions/${m[1]}.html`,
        title: cwe.replace(/^CWE-\d+:?\s*/i, "").trim() || `CWE-${m[1]}`,
      };
    }
  }

  const owasp = firstString(meta.owasp);
  if (owasp) {
    const m = owasp.match(/A(\d+)/i);
    if (m) {
      return {
        id: `OWASP-A${m[1].padStart(2, "0")}`,
        source: "owasp",
        ref: "https://owasp.org/www-project-top-ten/",
        title: owasp.trim(),
      };
    }
  }

  return null;
}

function normalizeSeverity(v: unknown): SemgrepFinding["severity"] {
  switch (String(v ?? "").toUpperCase()) {
    case "ERROR":
      return "error";
    case "WARNING":
      return "warning";
    default:
      return "info";
  }
}

/** Parse Semgrep `--json` output into normalized, cited findings. PURE (no I/O). */
export function parseSemgrepResults(json: unknown): SemgrepFinding[] {
  const root = asRecord(json);
  const results = root?.results;
  if (!Array.isArray(results)) return [];

  const out: SemgrepFinding[] = [];
  for (const entry of results) {
    const r = asRecord(entry);
    if (!r) continue;
    const ruleId = typeof r.check_id === "string" ? r.check_id : null;
    if (!ruleId) continue;
    const extra = asRecord(r.extra) ?? {};
    const start = asRecord(r.start);
    const line = typeof start?.line === "number" ? start.line : null;
    out.push({
      ruleId,
      message: typeof extra.message === "string" ? extra.message.trim() : "",
      file: typeof r.path === "string" ? r.path : "",
      line,
      severity: normalizeSeverity(extra.severity),
      rule: citationFromMetadata(extra.metadata),
    });
  }
  return out;
}

export interface SemgrepRunResult {
  available: boolean;
  findings: SemgrepFinding[];
}

/** Run Semgrep once (if installed) and return parsed findings. Never throws. */
export async function runSemgrep(): Promise<SemgrepRunResult> {
  const version = await execFileNoThrow("semgrep", ["--version"], { timeout: 5_000 });
  if (!version.ok) return { available: false, findings: [] };

  const result = await execFileNoThrow(
    "semgrep",
    ["scan", "--config", "auto", "--json", "--quiet", "--no-rewrite-rule-ids"],
    { timeout: 120_000 },
  );
  try {
    return { available: true, findings: parseSemgrepResults(JSON.parse(result.stdout || result.stderr)) };
  } catch {
    return { available: true, findings: [] };
  }
}
