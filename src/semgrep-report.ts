import {
  isOtherScannerFormat,
  reportText,
  scannerRecord,
  type ScannerReport,
} from "./check-scanner-evidence.js";
import { parseJsonObject } from "./utils/json-object.js";

const MAX_SEMGREP_REPORT_BYTES = 64 * 1024 * 1024;

interface SemgrepReport extends ScannerReport {
  blocking: boolean;
  scanned: number;
}

function findingLevel(value: unknown): "blocking" | "warning" | "ignored" | undefined {
  if (
    !scannerRecord(value) ||
    !reportText(value.check_id) ||
    !reportText(value.path) ||
    !scannerRecord(value.extra)
  )
    return undefined;
  switch (value.extra.severity) {
    case "ERROR":
    case "HIGH":
    case "CRITICAL":
      return "blocking";
    case "WARNING":
    case "MEDIUM":
      return "warning";
    case "INFO":
    case "LOW":
    case "INVENTORY":
    case "EXPERIMENT":
      return "ignored";
    default:
      return undefined;
  }
}

export function readSemgrepReport(raw: string): SemgrepReport {
  const report: SemgrepReport = { count: 0, blocking: false, scanned: 0 };
  if (!raw.trim()) return { ...report, gap: "missing" };
  const parsed = parseJsonObject(Buffer.from(raw), MAX_SEMGREP_REPORT_BYTES);
  if ("issues" in parsed) return { ...report, gap: "malformed", note: parsed.issues[0].message };
  const doc = parsed.value;
  if (!Array.isArray(doc.results))
    return { ...report, gap: isOtherScannerFormat(doc) ? "unsupported" : "malformed" };

  for (const entry of doc.results) {
    const level = findingLevel(entry);
    if (level === undefined) report.gap = "partial";
    if (level === "blocking" || level === "warning") report.count++;
    if (level === "blocking") report.blocking = true;
  }
  return assessCoverage(report, doc);
}

function assessCoverage(report: SemgrepReport, doc: Record<string, unknown>): SemgrepReport {
  const scanned = scannerRecord(doc.paths) ? doc.paths.scanned : undefined;
  if (!Array.isArray(scanned) || !Array.isArray(doc.errors))
    return {
      ...report,
      gap: "malformed",
      note: "Semgrep report must include errors and paths.scanned arrays",
    };
  if (!scanned.every(reportText))
    return { ...report, gap: "partial", note: "Semgrep reported an invalid scanned path" };
  report.scanned = scanned.length;
  if (doc.errors.length > 0)
    return {
      ...report,
      gap: "partial",
      note: `Semgrep reported ${doc.errors.length} scan error(s)`,
    };
  if (doc.skipped_rules !== undefined) {
    if (!Array.isArray(doc.skipped_rules)) return { ...report, gap: "malformed" };
    if (doc.skipped_rules.length)
      return { ...report, gap: "partial", note: "Semgrep reported skipped rules" };
  }
  if (report.scanned === 0)
    return {
      ...report,
      gap: report.gap ?? (report.count > 0 ? "partial" : "missing"),
      note: "Semgrep reported no scanned files",
    };
  return report;
}
