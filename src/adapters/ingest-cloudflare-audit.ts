/**
 * Cloudflare security-audit skill → kit findings.
 *
 * The skill (github.com/cloudflare/security-audit-skill, MIT) has a model hunt for
 * vulnerabilities, then writes `findings.json` to `report-schema.json` and checks it with its
 * own deterministic validators. Every record carries a verdict:
 *
 *   confirmed         source trace, evidence, and likelihood/impact/overall severity
 *   needs_validation  an exact unresolved fact and no severity
 *   rejected          a candidate the audit disproved
 *
 * kit owns this ingest schema and the mapping, never the judgement (ADR-0007). `confirmed` is a
 * failing finding at its own overall severity, `needs_validation` a low warning marked
 * unverified, and `rejected` is counted in a note, never ingested. A repeated fingerprint is
 * refused: it is the stable key. kit-research
 * `twelve-security-repos-list-vs-kit` chose this adapter.
 *
 * Pure: a string in, findings out. No file, network or model access.
 */
import type { SecurityCheckResult } from "../check-security.js";

type Severity = NonNullable<SecurityCheckResult["severity"]>;

const VERDICTS = new Set(["confirmed", "needs_validation", "rejected"]);
const SCORES = new Set(["informational", "low", "medium", "high", "critical"]);

interface TraceStep {
  kind?: string;
  file: string;
  line: number;
}

interface AuditRecord {
  verdict: "confirmed" | "needs_validation" | "rejected";
  fingerprint: string;
  title: string;
  trace: TraceStep[];
  severity?: { overall_severity: string };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value !== "";
const isStep = (value: unknown): boolean =>
  isRecord(value) &&
  nonEmpty(value.file) &&
  typeof value.line === "number" &&
  Number.isInteger(value.line) &&
  value.line > 0;

/** Why a record cannot be ingested, or null. Only the fields kit reads are checked. */
function recordProblem(value: unknown, index: number): string | null {
  const at = `record ${index}`;
  if (!isRecord(value)) return `${at} is not an object`;
  if (!nonEmpty(value.verdict) || !VERDICTS.has(value.verdict))
    return `${at} has no known verdict (confirmed, needs_validation, rejected)`;
  if (!nonEmpty(value.fingerprint) || !nonEmpty(value.title))
    return `${at} lacks a fingerprint or title`;
  if (!Array.isArray(value.trace) || value.trace.length === 0 || !value.trace.every(isStep))
    return `${at} has no source trace with a file and a positive line`;
  if (value.verdict !== "confirmed") return null;
  const severity = value.severity;
  const overall = isRecord(severity) ? severity.overall_severity : undefined;
  return nonEmpty(overall) && SCORES.has(overall)
    ? null
    : `${at} is confirmed without an overall_severity`;
}

/** The step a finding points at: the sink when the trace names one, else its last step. */
function sinkOf(trace: TraceStep[]): TraceStep {
  return trace.find((step) => step.kind === "sink") ?? trace[trace.length - 1];
}

function toFinding(record: AuditRecord): SecurityCheckResult {
  const sink = sinkOf(record.trace);
  const where = `${sink.file}:${sink.line}`;
  if (record.verdict === "confirmed") {
    const overall = record.severity?.overall_severity ?? "low";
    const severity: Severity = overall === "informational" ? "low" : (overall as Severity);
    return {
      category: "exposure",
      name: `cloudflare-audit: ${record.fingerprint}`,
      status: "fail",
      detail: `${record.title} (${where})`,
      severity,
    };
  }
  return {
    category: "exposure",
    name: `cloudflare-audit: ${record.fingerprint}`,
    status: "warn",
    detail: `unverified, needs validation: ${record.title} (${where})`,
    severity: "low",
  };
}

export type CloudflareAuditOutcome =
  { ok: true; findings: SecurityCheckResult[]; notes: string[] } | { ok: false; reason: string };

/**
 * Validate a parsed `findings.json` and map it. An empty array is a valid report that found
 * nothing. Any record kit cannot read fails the whole report, so a broken run never reads as
 * clean.
 */
export function ingestCloudflareAudit(parsed: unknown): CloudflareAuditOutcome {
  if (!Array.isArray(parsed))
    return { ok: false, reason: "not a Cloudflare audit findings.json (not an array)" };
  const seen = new Set<string>();
  for (let i = 0; i < parsed.length; i++) {
    const problem = recordProblem(parsed[i], i);
    if (problem) return { ok: false, reason: `invalid Cloudflare audit report: ${problem}` };
    const { fingerprint } = parsed[i] as AuditRecord;
    if (seen.has(fingerprint))
      return {
        ok: false,
        reason: `invalid Cloudflare audit report: record ${i} repeats a fingerprint`,
      };
    seen.add(fingerprint);
  }
  const records = parsed as AuditRecord[];
  const findings = records.filter((r) => r.verdict !== "rejected").map(toFinding);
  const rejected = records.length - findings.length;
  const notes =
    rejected > 0 ? [`${rejected} candidate(s) the audit rejected were counted, not ingested.`] : [];
  return { ok: true, findings, notes };
}
