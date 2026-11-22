import type { SecurityCheckResult } from "./check-security.js";
import { failedDetail, type ExecResult } from "./utils/execFileNoThrow.js";

export type ScannerReportGap = "missing" | "malformed" | "partial" | "unsupported" | "unavailable";
export type ScannerEvidenceStatus = ScannerReportGap | "complete" | "complete-empty";

export interface ScannerReport {
  count: number;
  gap?: ScannerReportGap;
  note?: string;
}

type ScannerExecution = Pick<
  ExecResult,
  "ok" | "exitCode" | "truncated" | "timedOut" | "noNumericExitStatus" | "didNotStart"
>;

export interface ScannerGap {
  status: ScannerReportGap;
  reason: string;
  didNotStart?: true;
}

export function scannerRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function reportText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function scannerObject(raw: string): Record<string, unknown> | undefined {
  try {
    const report: unknown = JSON.parse(raw);
    return scannerRecord(report) ? report : undefined;
  } catch {
    return undefined;
  }
}

/** Known formats that this reader did not request. */
export function isOtherScannerFormat(doc: Record<string, unknown>): boolean {
  if (reportText(doc.spdxVersion) || doc.bomFormat === "CycloneDX") return true;
  return doc.version === "2.1.0" && Array.isArray(doc.runs);
}

const reportReason: Record<ScannerReportGap, string> = {
  missing: "scanner returned no report or covered target",
  malformed: "scanner returned a malformed report",
  partial: "scanner report contains incomplete or invalid records",
  unsupported: "scanner used an unsupported report format",
  unavailable: "scanner did not complete",
};

function interruptedScan(process: ScannerExecution, hasFindings: boolean): ScannerGap | undefined {
  if (process.truncated || process.timedOut)
    return { status: "partial", reason: failedDetail("scanner did not complete", process) };
  if (process.didNotStart)
    return { status: "unavailable", reason: "scanner could not start", didNotStart: true };
  if (process.noNumericExitStatus)
    return {
      status: hasFindings ? "partial" : "unavailable",
      reason: "scanner stopped without an exit status",
    };
  return undefined;
}

export function scannerGap(
  report: ScannerReport,
  process: ScannerExecution,
  exits: { findings?: number; noTarget?: number } = {},
): ScannerGap | undefined {
  const stopped = interruptedScan(process, report.count > 0);
  if (stopped) return stopped;
  if (!process.ok && process.exitCode === exits.noTarget && report.count === 0)
    return { status: "missing", reason: "scanner found no packages to check" };
  const resultExit = process.exitCode === exits.findings && report.count > 0;
  if (!process.ok && !resultExit)
    return {
      status: report.count > 0 ? "partial" : "unavailable",
      reason: `scanner failed with exit code ${process.exitCode}`,
    };
  if (report.gap) return { status: report.gap, reason: report.note ?? reportReason[report.gap] };
  return undefined;
}

export function scannerEvidence(
  row: SecurityCheckResult,
  count: number,
  gap?: ScannerGap,
): SecurityCheckResult {
  if (!gap) return { ...row, evidenceStatus: count > 0 ? "complete" : "complete-empty" };
  const detail =
    count > 0
      ? row.detail + ". Coverage unverified: " + gap.reason
      : "Coverage unverified: " + gap.reason;
  return {
    ...row,
    status: row.status === "fail" ? "fail" : "warn",
    detail,
    severity: count > 0 ? row.severity : "medium",
    didNotRun: true,
    ...(gap.didNotStart ? {} : { scanIncomplete: true }),
    ...(count > 0 ? { hasFindings: true } : {}),
    evidenceStatus: gap.status,
  };
}
