import {
  isOtherScannerFormat,
  reportText,
  scannerObject,
  scannerRecord,
  type ScannerReport,
} from "./check-scanner-evidence.js";

export const OSV_EXITS = { findings: 1, noTarget: 128 };

interface OsvPackageIdentity {
  name: string;
  version?: string;
  ecosystem?: string;
}

export interface OsvPackage {
  package?: OsvPackageIdentity;
  vulnerabilities: { id: string }[];
  groups: { max_severity?: string }[];
}

export interface OsvReport extends ScannerReport {
  packages: OsvPackage[];
}

function packageIdentity(value: unknown): OsvPackageIdentity | undefined {
  if (!scannerRecord(value) || !reportText(value.name)) return undefined;
  const { name, version, ecosystem } = value;
  if (version !== undefined && typeof version !== "string") return undefined;
  if (ecosystem !== undefined && typeof ecosystem !== "string") return undefined;
  return { name, version, ecosystem };
}

function vulnerability(value: unknown): value is { id: string } {
  return scannerRecord(value) && reportText(value.id);
}

function group(value: unknown): value is { max_severity?: string } {
  return (
    scannerRecord(value) &&
    (value.max_severity === undefined || typeof value.max_severity === "string")
  );
}

function records<T>(
  value: unknown,
  valid: (item: unknown) => item is T,
): {
  items: T[];
  incomplete: boolean;
} {
  if (value === undefined) return { items: [], incomplete: false };
  if (!Array.isArray(value)) return { items: [], incomplete: true };
  const items = value.filter(valid);
  return { items, incomplete: items.length !== value.length };
}

function readPackage(value: unknown, report: OsvReport): void {
  if (!scannerRecord(value)) {
    report.gap = "partial";
    return;
  }
  const identity = packageIdentity(value.package);
  const vulns = records(value.vulnerabilities, vulnerability);
  const groups = records(value.groups, group);
  if (!identity || vulns.incomplete || groups.incomplete) report.gap = "partial";
  if (vulns.items.length === 0) return;
  report.count += vulns.items.length;
  // Omit the scores when group data was dropped. The formatter treats such advisories as unscored.
  report.packages.push({
    package: identity,
    vulnerabilities: vulns.items,
    groups: groups.incomplete ? [] : groups.items,
  });
}

export function readOsvReport(raw: string): OsvReport {
  const report: OsvReport = { count: 0, packages: [] };
  if (!raw.trim()) return { ...report, gap: "missing" };
  const doc = scannerObject(raw);
  if (!doc) return { ...report, gap: "malformed" };
  if (!Array.isArray(doc.results))
    return { ...report, gap: isOtherScannerFormat(doc) ? "unsupported" : "malformed" };
  for (const result of doc.results) {
    if (!scannerRecord(result) || !Array.isArray(result.packages)) {
      report.gap = "partial";
      continue;
    }
    for (const value of result.packages) readPackage(value, report);
  }
  return report;
}
