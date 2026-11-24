import {
  reportText,
  scannerGap,
  scannerObject,
  scannerRecord,
  type ScannerGap,
  type ScannerReport,
} from "./check-scanner-evidence.js";
import type { ExecResult } from "./utils/execFileNoThrow.js";

const severities = ["info", "low", "moderate", "high", "critical"] as const;
const packageName = /^(@[\w.-]+\/)?[\w.~-]+$/i;
type Severity = (typeof severities)[number];
type Counts = Record<Severity | "total", number>;
type Advisory = { severity: Severity; url: string; title?: string };
type Vulnerability = { name: string; severity: Severity; via: (string | Advisory)[] };
type Minimum = "info" | "high";

export interface NpmAuditReport extends ScannerReport {
  inventory?: number;
  metadata: { vulnerabilities: Counts };
  vulnerabilities: Record<string, Vulnerability>;
}

export function npmAuditArgs(level: Minimum): string[] {
  return [
    "audit",
    `--audit-level=${level}`,
    "--json",
    "--package-lock-only",
    "--include=prod",
    "--include=dev",
    "--include=optional",
    "--include=peer",
  ];
}

function isSeverity(value: unknown): value is Severity {
  return typeof value === "string" && severities.some((severity) => severity === value);
}

function readVia(value: unknown): (string | Advisory)[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown): (string | Advisory)[] => {
    if (reportText(entry)) return [entry];
    if (!scannerRecord(entry) || !isSeverity(entry.severity) || !reportText(entry.url)) return [];
    const title = reportText(entry.title) ? entry.title : undefined;
    return [{ severity: entry.severity, url: entry.url, title }];
  });
}

function readFindings(value: unknown): {
  vulnerabilities: NpmAuditReport["vulnerabilities"];
  partial: boolean;
} {
  const vulnerabilities: NpmAuditReport["vulnerabilities"] = Object.create(null);
  if (!scannerRecord(value)) return { vulnerabilities, partial: true };
  let partial = false;
  for (const [name, entry] of Object.entries(value)) {
    if (
      !packageName.test(name) ||
      !scannerRecord(entry) ||
      entry.name !== name ||
      !isSeverity(entry.severity)
    ) {
      partial = true;
      continue;
    }
    const via = readVia(entry.via);
    if (!Array.isArray(entry.via) || via.length === 0 || via.length !== entry.via.length)
      partial = true;
    vulnerabilities[name] = { name, severity: entry.severity, via };
  }
  return { vulnerabilities, partial };
}

function countFindings(vulnerabilities: NpmAuditReport["vulnerabilities"]): Counts {
  const counts: Counts = { critical: 0, high: 0, moderate: 0, low: 0, info: 0, total: 0 };
  for (const { severity } of Object.values(vulnerabilities)) {
    counts[severity] += 1;
    counts.total += 1;
  }
  return counts;
}

/** Every report severity must trace to direct advisory evidence. */
function coversVia(findings: NpmAuditReport["vulnerabilities"]): boolean {
  const dependents = new Map<string, string[]>();
  const severityByPackage = new Map<string, number>();
  for (const [name, { severity, via }] of Object.entries(findings)) {
    const declared = severities.indexOf(severity);
    for (const cause of via) {
      if (typeof cause !== "string") {
        const rank = severities.indexOf(cause.severity);
        if (rank > declared) return false;
        severityByPackage.set(name, Math.max(rank, severityByPackage.get(name) ?? -1));
        continue;
      }
      if (!Object.hasOwn(findings, cause)) return false;
      const names = dependents.get(cause) ?? [];
      names.push(name);
      dependents.set(cause, names);
    }
  }

  // Only queue an improvement. Every package can advance at most once per severity.
  const pending = [...severityByPackage.keys()];
  for (const cause of pending) {
    const rank = severityByPackage.get(cause) ?? -1;
    for (const name of dependents.get(cause) ?? []) {
      if (rank <= (severityByPackage.get(name) ?? -1)) continue;
      severityByPackage.set(name, rank);
      pending.push(name);
    }
  }
  return Object.values(findings).every(
    ({ name, severity }) => (severityByPackage.get(name) ?? -1) >= severities.indexOf(severity),
  );
}

function readInventory(value: unknown): number | undefined {
  if (!scannerRecord(value) || !scannerRecord(value.dependencies)) return undefined;
  const total = value.dependencies.total;
  return typeof total === "number" && Number.isSafeInteger(total) && total >= 0 ? total : undefined;
}

function metadataMatches(value: unknown, counts: Counts, total: number): boolean {
  if (!scannerRecord(value) || !scannerRecord(value.vulnerabilities)) return false;
  const declared = value.vulnerabilities;
  return (
    total >= counts.total && Object.entries(counts).every(([key, count]) => declared[key] === count)
  );
}

function withFindings(
  vulnerabilities: NpmAuditReport["vulnerabilities"],
  gap?: ScannerReport["gap"],
  note?: string,
): NpmAuditReport {
  const counts = countFindings(vulnerabilities);
  return { count: counts.total, metadata: { vulnerabilities: counts }, vulnerabilities, gap, note };
}

export function readNpmAuditReport(text: string): NpmAuditReport {
  if (!text.trim()) return withFindings({}, "missing", "npm produced no audit report");
  const doc = scannerObject(text);
  if (!doc) return withFindings({}, "malformed", "npm produced invalid audit JSON");
  if (doc.auditReportVersion === undefined) {
    return Object.hasOwn(doc, "error")
      ? withFindings({}, "unavailable", "npm reported an audit error")
      : withFindings({}, "malformed", "npm audit report has no version");
  }
  if (doc.auditReportVersion !== 2)
    return withFindings({}, "unsupported", "npm audit report version is unsupported");
  const { vulnerabilities, partial } = readFindings(doc.vulnerabilities);
  const report = { ...withFindings(vulnerabilities), inventory: readInventory(doc.metadata) };
  if (Object.hasOwn(doc, "error"))
    return {
      ...report,
      gap: report.count > 0 ? "partial" : "unavailable",
      note: "npm reported an audit error",
    };
  if (
    partial ||
    report.inventory === undefined ||
    !metadataMatches(doc.metadata, report.metadata.vulnerabilities, report.inventory) ||
    !coversVia(vulnerabilities)
  ) {
    return {
      ...report,
      gap: report.count > 0 ? "partial" : "malformed",
      note: "npm audit counts or findings do not establish complete coverage",
    };
  }
  return report;
}

export function npmAuditGap(
  report: NpmAuditReport,
  execution: ExecResult,
  level: Minimum,
): ScannerGap | undefined {
  const { total, high, critical } = report.metadata.vulnerabilities;
  const observed = level === "high" ? high + critical : total;
  if (execution.timedOut) return { status: "partial", reason: "npm audit timed out" };
  if (execution.ok && observed > 0)
    return { status: "partial", reason: "npm audit exit disagrees with its findings" };
  return scannerGap(report, execution, observed > 0 ? { findings: 1 } : {});
}
