import { stripVTControlCharacters } from "node:util";
import type { Advisory, AuditOutcome, Severity } from "./advisory-baseline.js";
import {
  isOtherScannerFormat,
  reportText,
  scannerObject,
  scannerRecord,
  type ScannerEvidenceStatus,
} from "./check-scanner-evidence.js";

const MAX_REPORT_LENGTH = 64 * 1024 * 1024;
const severities: readonly Severity[] = ["info", "low", "moderate", "high", "critical"];
const packageName = /^(?:@[\w.~-]+\/)?[\w.~-]+$/;
const ghsa =
  /^GHSA-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}$/i;
const githubAdvisoryUrl = /^https:\/\/github\.com\/advisories\/([^/?#]+)\/?$/i;
const errorDiagnostic =
  /(?:^|\n)[^\S\r\n]*(?:(?:ERR_PNPM_[A-Z0-9_]+|ERROR)\b|The audit endpoint \(at )/;

type PnpmAuditOutcome = Omit<AuditOutcome, "manager"> & { evidenceStatus: ScannerEvidenceStatus };

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function ghsaId(value: unknown): string | undefined {
  return typeof value === "string" && ghsa.test(value) ? value.toUpperCase() : undefined;
}

function readAdvisoryId(row: Record<string, unknown>): string | undefined {
  const id = ghsaId(row.github_advisory_id);
  const url = typeof row.url === "string" ? githubAdvisoryUrl.exec(row.url)?.[1] : undefined;
  const urlId = ghsaId(url);
  if (id && urlId && id !== urlId) return undefined;
  return id ?? urlId;
}

function readFindingPaths(value: unknown): unknown[] {
  if (!scannerRecord(value) || !reportText(value.version) || !Array.isArray(value.paths)) return [];
  return value.paths;
}

function reportIdMatches(key: string, id: unknown): boolean {
  return count(id) && id > 0 && String(id) === key;
}

function readAdvisory(key: string, row: unknown) {
  if (
    !scannerRecord(row) ||
    !reportIdMatches(key, row.id) ||
    typeof row.module_name !== "string" ||
    !packageName.test(row.module_name) ||
    !Array.isArray(row.findings)
  )
    return undefined;

  const id = readAdvisoryId(row);
  const severity = severities.find((entry) => entry === row.severity);
  if (!id || !severity) return undefined;

  let hasPath = false;
  let complete = reportText(row.vulnerable_versions);
  for (const finding of row.findings) {
    const paths = readFindingPaths(finding);
    if (paths.some(reportText)) hasPath = true;
    if (paths.length === 0 || !paths.every(reportText)) complete = false;
  }
  if (!hasPath) return undefined;

  const title =
    typeof row.title === "string"
      ? stripVTControlCharacters(row.title).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
      : "";
  const advisory: Advisory = { id, package: row.module_name, severity, title };
  return { advisory, complete };
}

function readAdvisories(value: unknown) {
  const counts: Record<Severity, number> = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
  const byId = new Map<string, Advisory>();
  if (!scannerRecord(value)) return { advisories: [], counts, complete: false };
  let complete = true;
  for (const [key, row] of Object.entries(value)) {
    const result = readAdvisory(key, row);
    if (!result?.complete) complete = false;
    if (!result) continue;
    const { advisory } = result;
    counts[advisory.severity]++;
    const previous = byId.get(advisory.id);
    if (!previous || severities.indexOf(advisory.severity) > severities.indexOf(previous.severity))
      byId.set(advisory.id, advisory);
  }
  const advisories = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  return { advisories, counts, complete };
}

function readInventory(metadata: Record<string, unknown>): number | undefined {
  const { dependencies, devDependencies, optionalDependencies, totalDependencies } = metadata;
  if (
    !count(dependencies) ||
    !count(devDependencies) ||
    !count(optionalDependencies) ||
    !count(totalDependencies)
  ) {
    return undefined;
  }
  // pnpm 11 counts a package that is both dev-only and optional-only in both categories.
  const nonProduction = totalDependencies - dependencies;
  return nonProduction >= Math.max(devDependencies, optionalDependencies) &&
    nonProduction - devDependencies <= optionalDependencies
    ? totalDependencies
    : undefined;
}

function reportShape(doc: Record<string, unknown>): boolean {
  const legacy = Object.hasOwn(doc, "actions") || Object.hasOwn(doc, "muted");
  if (legacy && (!Array.isArray(doc.actions) || !Array.isArray(doc.muted) || doc.muted.length > 0))
    return false;
  return Object.keys(doc).length === (legacy ? 4 : 2);
}

function failed(
  advisories: Advisory[],
  evidenceStatus: ScannerEvidenceStatus,
  error: string,
): PnpmAuditOutcome {
  return { advisories, evidenceStatus, error };
}

interface PnpmExecution {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error?: string;
}

function executionError(
  execution: PnpmExecution,
  doc: Record<string, unknown> | undefined,
): string | undefined {
  const { stdout, stderr, exitCode, error } = execution;
  if (error !== undefined || exitCode === null) return "pnpm audit did not complete";
  if (exitCode !== 0 && exitCode !== 1) return `pnpm audit failed with exit code ${exitCode}`;
  if (
    (doc && Object.hasOwn(doc, "error")) ||
    errorDiagnostic.test(stripVTControlCharacters(stderr)) ||
    (!doc && errorDiagnostic.test(stripVTControlCharacters(stdout)))
  )
    return "pnpm reported an audit error";
  return undefined;
}

function countsMatch(
  declared: unknown,
  counts: ReturnType<typeof readAdvisories>["counts"],
): boolean {
  return (
    scannerRecord(declared) &&
    Object.keys(declared).length === severities.length &&
    severities.every((severity) => declared[severity] === counts[severity])
  );
}

function validatedReport(
  doc: Record<string, unknown>,
  findings: ReturnType<typeof readAdvisories>,
  exitCode: number | null,
  expectedEntries?: number,
): PnpmAuditOutcome {
  const { advisories, counts, complete } = findings;
  const { metadata } = doc;
  if (
    !scannerRecord(metadata) ||
    !reportShape(doc) ||
    !complete ||
    !countsMatch(metadata.vulnerabilities, counts)
  )
    return failed(
      advisories,
      "partial",
      "pnpm audit counts or findings do not establish complete coverage",
    );

  const inventory = readInventory(metadata);
  if (inventory === undefined || (inventory === 0 && advisories.length > 0))
    return failed(advisories, "partial", "pnpm audit dependency inventory is invalid");
  if (expectedEntries !== undefined && inventory !== expectedEntries)
    return failed(
      advisories,
      "partial",
      "pnpm audit dependency inventory does not match the lockfile",
    );

  if (exitCode !== (advisories.length > 0 ? 1 : 0))
    return failed(
      advisories,
      advisories.length ? "partial" : "unavailable",
      "pnpm audit exit disagrees with its findings",
    );
  return { advisories, evidenceStatus: advisories.length > 0 ? "complete" : "complete-empty" };
}

/** Read pnpm 10's registry report and pnpm 11's bulk audit report. */
export function readPnpmAuditEvidence(
  execution: PnpmExecution,
  expectedEntries?: number,
): Omit<AuditOutcome, "manager"> {
  const { stdout, exitCode } = execution;
  if (stdout.length > MAX_REPORT_LENGTH)
    return failed([], "partial", "pnpm audit output exceeds the report size limit");

  const doc = scannerObject(stdout);
  const findings = readAdvisories(doc?.advisories);
  const { advisories } = findings;
  const error = executionError(execution, doc);
  if (error) return failed(advisories, advisories.length ? "partial" : "unavailable", error);
  if (doc && (isOtherScannerFormat(doc) || Object.hasOwn(doc, "auditReportVersion")))
    return failed(advisories, "unsupported", "pnpm audit report format is unsupported");
  if (!doc || (!Object.hasOwn(doc, "advisories") && !Object.hasOwn(doc, "metadata"))) {
    if (exitCode === 1)
      return failed([], "unavailable", "pnpm audit failed without an audit report");
    if (!stdout.trim()) return failed([], "missing", "pnpm returned no audit report");
    return failed([], "malformed", "pnpm did not return a recognized audit report");
  }
  return validatedReport(doc, findings, exitCode, expectedEntries);
}
