import { scannerRecord, type ScannerGap } from "./check-scanner-evidence.js";
import { parseJsonObject } from "./utils/json-object.js";

export const BUMBLEBEE_REPORT_LIMIT = 32 * 1024 * 1024;

export interface BumblebeeFinding {
  severity: string;
  catalogId: string;
  catalogName: string;
  ecosystem: string;
  packageName: string;
  version: string;
  sourceFile: string;
  evidence: string;
}

export interface ScanOutcome {
  status: string;
  timedOut: boolean;
  summarySeen: boolean;
  findings: BumblebeeFinding[];
  packagesScanned: number;
  profile?: string;
  roots?: string[];
  catalogMtime?: number;
  gap?: ScannerGap;
}

type RecordData = Record<string, unknown>;

interface ScanSummary {
  status: "complete" | "partial" | "error";
  timedOut: boolean;
  profile: string;
  packagesEmitted: number;
  packagesSuppressed: number;
  findingsEmitted: number;
  filesConsidered: number;
  roots: string[];
}

interface ReportRecords {
  findings: BumblebeeFinding[];
  summary?: ScanSummary;
  summarySeen: boolean;
  runs: Set<string>;
  packages: number;
  gap?: ScannerGap;
}

function validCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function optionalText(record: RecordData, key: string): string {
  const text = record[key];
  return typeof text === "string" ? text : "";
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function packageIdentity(record: RecordData) {
  const ecosystem = record.ecosystem;
  const version = record.version;
  const packageName = optionalText(record, "package_name") || record.normalized_name;
  // Empty version means the scanner reported an unknown version.
  if (!nonempty(ecosystem) || !nonempty(packageName) || typeof version !== "string")
    return undefined;
  return { ecosystem, packageName, version };
}

function readFinding(record: RecordData): BumblebeeFinding | undefined {
  const catalogId = record.catalog_id;
  const identity = packageIdentity(record);
  if (!identity || record.finding_type !== "package_exposure" || !nonempty(catalogId))
    return undefined;
  return {
    severity: optionalText(record, "severity") || "unknown",
    catalogId,
    catalogName: optionalText(record, "catalog_name"),
    ...identity,
    sourceFile: optionalText(record, "source_file"),
    evidence: optionalText(record, "evidence"),
  };
}

function readRoots(value: unknown): string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const roots: string[] = [];
  for (const root of value) {
    if (!scannerRecord(root) || !nonempty(root.path)) return undefined;
    roots.push(root.path);
  }
  return roots;
}

function readSummary(record: RecordData): ScanSummary | undefined {
  const { status, profile, timed_out: timedOut } = record;
  const {
    package_records_emitted: packagesEmitted,
    package_records_suppressed: packagesSuppressed = 0,
    findings_emitted: findingsEmitted,
    files_considered: filesConsidered,
  } = record;
  const roots = readRoots(record.roots);
  if (status !== "complete" && status !== "partial" && status !== "error") return undefined;
  if (profile !== "baseline" && profile !== "project" && profile !== "deep") return undefined;
  if (typeof timedOut !== "boolean" || !roots) return undefined;
  if (!validCounter(packagesEmitted) || !validCounter(packagesSuppressed)) return undefined;
  if (!validCounter(findingsEmitted) || !validCounter(filesConsidered)) return undefined;
  if (!Number.isSafeInteger(packagesEmitted + packagesSuppressed)) return undefined;
  return {
    status,
    profile,
    timedOut,
    packagesEmitted,
    packagesSuppressed,
    findingsEmitted,
    filesConsidered,
    roots,
  };
}

function recordIssue(state: ReportRecords, status: ScannerGap["status"], reason: string): void {
  state.gap ??= { status, reason };
}

function addRecord(state: ReportRecords, record: RecordData): void {
  const { record_type: type, run_id: run } = record;
  if (!nonempty(run)) {
    recordIssue(state, "malformed", "report record has no run ID");
    return;
  }
  if (
    type !== "diagnostic" &&
    (record.schema_version !== "0.1.0" || record.scanner_name !== "bumblebee")
  ) {
    recordIssue(state, "unsupported", "unsupported Bumblebee record schema or scanner");
    return;
  }
  state.runs.add(run);
  if (type === "finding") {
    const finding = readFinding(record);
    if (finding) state.findings.push(finding);
    else recordIssue(state, "malformed", "invalid exposure record");
  } else if (type === "package") {
    if (packageIdentity(record)) state.packages++;
    else recordIssue(state, "malformed", "invalid package record");
  } else if (type === "scan_summary") {
    state.summarySeen = true;
    state.summary ??= readSummary(record);
    if (!state.summary) recordIssue(state, "malformed", "invalid scan summary");
  } else if (type === "diagnostic") {
    if (record.level === "error") recordIssue(state, "partial", "scanner reported a scan error");
    else if (!["debug", "info", "warn"].includes(String(record.level)))
      recordIssue(state, "malformed", "invalid diagnostic record");
  } else recordIssue(state, "unsupported", "unsupported Bumblebee record type");
}

function reportGap(state: ReportRecords): ScannerGap | undefined {
  const { summary, findings, runs, packages, gap } = state;
  if (gap) return summary || findings.length > 0 ? { ...gap, status: "partial" } : gap;
  if (!summary)
    return { status: runs.size > 0 ? "partial" : "missing", reason: "scan summary missing" };
  if (runs.size !== 1) return { status: "partial", reason: "report contains multiple run IDs" };
  if (summary.status !== "complete" || summary.timedOut)
    return {
      status: "partial",
      reason: `scan incomplete (status=${summary.status}${summary.timedOut ? ", timed out" : ""})`,
    };
  if (summary.findingsEmitted !== findings.length || summary.packagesEmitted !== packages)
    return { status: "partial", reason: "report counts do not match the scan summary" };
  if (summary.filesConsidered === 0 && summary.packagesEmitted + summary.packagesSuppressed === 0)
    return { status: "missing", reason: "scanner reported no covered files or packages" };
  return undefined;
}

/** Evaluate the pinned scanner's NDJSON summary and recover independently valid findings. */
export function parseScanOutput(stdout: string): ScanOutcome {
  const state: ReportRecords = { findings: [], summarySeen: false, packages: 0, runs: new Set() };
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    if (state.summarySeen)
      recordIssue(state, "partial", "report has records after the scan summary");
    const parsed = parseJsonObject(Buffer.from(line), BUMBLEBEE_REPORT_LIMIT);
    if ("issues" in parsed) recordIssue(state, "malformed", "invalid Bumblebee JSON record");
    else addRecord(state, parsed.value);
  }
  const summary = state.summary;
  return {
    status: summary?.status ?? "unknown",
    timedOut: summary?.timedOut ?? false,
    summarySeen: state.summarySeen,
    findings: state.findings,
    packagesScanned: summary ? summary.packagesEmitted + summary.packagesSuppressed : 0,
    profile: summary?.profile,
    roots: summary?.roots,
    gap: reportGap(state),
  };
}
