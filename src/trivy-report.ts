import { posix } from "node:path";
import {
  isOtherScannerFormat,
  reportText,
  scannerObject,
  scannerRecord,
  type ScannerReport,
} from "./check-scanner-evidence.js";

type ResultKind = "vulnerability" | "configuration" | "maven" | "gradle";
type TargetScope = "required" | "supplemental" | "other";

const SEVERITIES = new Set(["UNKNOWN", "LOW", "MEDIUM", "HIGH", "CRITICAL"]);
const CONFIG_STATES = new Set(["FAIL", "PASS", "EXCEPTION"]);
const PACKAGE_CLASSES = new Set(["os-pkgs", "lang-pkgs"]);
const JVM_TYPES = new Set(["pom", "gradle", "jar"]);

function classifyRecord(value: unknown, kind: ResultKind): number | undefined {
  if (
    !scannerRecord(value) ||
    typeof value.Severity !== "string" ||
    !SEVERITIES.has(value.Severity)
  )
    return undefined;
  const high = value.Severity === "HIGH" || value.Severity === "CRITICAL";
  if (kind !== "configuration") return reportText(value.VulnerabilityID) ? Number(high) : undefined;
  if (!reportText(value.ID) || typeof value.Status !== "string" || !CONFIG_STATES.has(value.Status))
    return undefined;
  return Number(high && value.Status === "FAIL");
}

function jvmMode(kind: ResultKind): boolean {
  return kind === "maven" || kind === "gradle";
}

function targetScope(row: Record<string, unknown>, kind: ResultKind): TargetScope | undefined {
  if (!reportText(row.Class)) return undefined;
  if (kind === "configuration") return row.Class === "config" ? "required" : "other";
  if (!jvmMode(kind)) return PACKAGE_CLASSES.has(row.Class) ? "required" : "other";
  if (row.Class !== "lang-pkgs") return "other";
  if (!reportText(row.Type)) return undefined;
  const requiredType = kind === "maven" ? "pom" : "gradle";
  if (row.Type === requiredType) return "required";
  return JVM_TYPES.has(row.Type) ? "supplemental" : "other";
}

function readRecords(records: unknown, kind: ResultKind, report: ScannerReport): void {
  if (records === undefined) return;
  if (!Array.isArray(records)) {
    report.gap = "partial";
    return;
  }
  for (const record of records) {
    const count = classifyRecord(record, kind);
    if (count === undefined) report.gap = "partial";
    else report.count += count;
  }
}

function checkConfigurationSummary(row: Record<string, unknown>, report: ScannerReport): void {
  const summary = row.MisconfSummary;
  if (summary === undefined) return;
  if (!scannerRecord(summary)) {
    report.gap = "partial";
    return;
  }
  const listed = Array.isArray(row.Misconfigurations) ? row.Misconfigurations : [];
  const failures = listed.filter((entry) => scannerRecord(entry) && entry.Status === "FAIL").length;
  const declared = summary.Failures === undefined ? 0 : summary.Failures;
  if (declared !== failures) report.gap = "partial";
}

function readResult(value: unknown, kind: ResultKind, report: ScannerReport): boolean {
  if (!scannerRecord(value)) {
    report.gap = "partial";
    return false;
  }
  const scope = targetScope(value, kind);
  if (scope === "other") return false;
  const valid = scope !== undefined && reportText(value.Target) && reportText(value.Type);
  if (!valid) report.gap = "partial";
  if (scope !== undefined || !jvmMode(kind)) {
    const records = kind === "configuration" ? value.Misconfigurations : value.Vulnerabilities;
    readRecords(records, kind, report);
    if (kind === "configuration") checkConfigurationSummary(value, report);
  }
  return valid && scope === "required";
}

function configKey(type: string, rawPath: string): string {
  const path = posix.normalize(rawPath.replaceAll("\\", "/"));
  const format = type === "docker-compose" ? "compose" : type;
  return `${format}:${path}`;
}

function expectedConfigKey(path: string): string {
  const name = posix.basename(path);
  if (name.endsWith(".tf")) return configKey("terraform", posix.dirname(path));
  return configKey(name.startsWith("Dockerfile") ? "dockerfile" : "compose", path);
}

function applyConfigCoverage(
  report: ScannerReport,
  expectedPaths: readonly string[],
  covered: Set<string>,
): void {
  const expected = new Set(expectedPaths.map(expectedConfigKey));
  const missing = [...expected].filter((target) => !covered.has(target));
  if (missing.length === 0) return;
  const seen = expected.size - missing.length;
  report.gap ??= seen > 0 || report.count > 0 ? "partial" : "missing";
  report.note = `Trivy reported ${seen} of ${expected.size} expected configuration target(s)`;
}

function readTargets(
  results: unknown[],
  kind: ResultKind,
  expectedPaths: readonly string[],
): ScannerReport {
  const report: ScannerReport = { count: 0 };
  const targets = new Set<string>();
  let covered = false;
  for (const row of results) {
    if (!readResult(row, kind, report)) continue;
    covered = true;
    if (
      kind === "configuration" &&
      scannerRecord(row) &&
      reportText(row.Type) &&
      reportText(row.Target)
    )
      targets.add(configKey(row.Type, row.Target));
  }
  if (expectedPaths.length > 0) applyConfigCoverage(report, expectedPaths, targets);
  if (!report.gap && !covered) report.gap = report.count > 0 ? "partial" : "missing";
  return report;
}

export function readTrivyReport(
  raw: string,
  kind: ResultKind,
  expectedPaths: readonly string[] = [],
): ScannerReport {
  if (!raw.trim()) return { count: 0, gap: "missing" };
  const doc = scannerObject(raw);
  if (!doc) return { count: 0, gap: "malformed" };
  if (!Number.isSafeInteger(doc.SchemaVersion))
    return { count: 0, gap: isOtherScannerFormat(doc) ? "unsupported" : "malformed" };
  if (doc.SchemaVersion !== 2) return { count: 0, gap: "unsupported" };
  if (!reportText(doc.ArtifactType) || !reportText(doc.ArtifactName))
    return { count: 0, gap: "malformed" };
  if (doc.ArtifactType !== "filesystem") return { count: 0, gap: "unsupported" };
  if (doc.Results === undefined) return { count: 0, gap: "missing" };
  if (!Array.isArray(doc.Results)) return { count: 0, gap: "malformed" };
  return readTargets(doc.Results, kind, expectedPaths);
}
