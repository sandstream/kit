import type { Advisory, AuditOutcome, Severity } from "./advisory-baseline.js";
import {
  reportText,
  scannerObject,
  scannerRecord,
  type ScannerEvidenceStatus,
} from "./check-scanner-evidence.js";

type YarnAuditEvidence = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error?: string;
};
type YarnAuditOutcome = Omit<AuditOutcome, "manager"> & { evidenceStatus: ScannerEvidenceStatus };

const severities = ["info", "low", "moderate", "high", "critical"] as const;
const packageName = /^(?:@[\w.~-]+\/)?[\w.~-]+$/;
const version =
  /^v?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[\da-z-]+(?:\.[\da-z-]+)*)?(?:\+[\da-z-]+(?:\.[\da-z-]+)*)?$/i;
const locator = /^(?:@[^/\s]+\/)?[^@/\s]+@\S.*$/;
const ghsa = "GHSA-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}";
const ghsaId = new RegExp(`^${ghsa}$`, "i");
const githubAdvisory = new RegExp(`^https://github\\.com/advisories/(${ghsa})/?$`, "i");
const childKeys = new Set([
  "ID",
  "Issue",
  "URL",
  "Severity",
  "Vulnerable Versions",
  "Tree Versions",
  "Dependents",
]);

function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && value === value.trim() && pattern.test(value);
}

function isSeverity(value: unknown): value is Severity {
  return severities.some((severity) => severity === value);
}

function advisoryId(children: Record<string, unknown>): string | undefined {
  const id = matches(children.ID, ghsaId) ? children.ID.toUpperCase() : undefined;
  const url = children.URL;
  const urlMatch = reportText(url) && url.trim() === url ? githubAdvisory.exec(url) : null;
  const urlId = urlMatch?.[1].toUpperCase();
  if (id && urlId && id !== urlId) return undefined;
  return id ?? urlId;
}

function readAdvisory(name: unknown, children: Record<string, unknown>): Advisory | undefined {
  const { Severity: severity, Issue: title } = children;
  if (!matches(name, packageName) || !isSeverity(severity) || !reportText(title)) return undefined;
  const id = advisoryId(children);
  if (id) return { id, package: name, severity, title };
  return undefined;
}

function entriesMatch(value: unknown, pattern: RegExp): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry: unknown) => matches(entry, pattern))
  );
}

function validRegistryId(value: unknown): boolean {
  return (
    reportText(value) || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
  );
}

function completeRow(row: Record<string, unknown>, children: Record<string, unknown>): boolean {
  return (
    Object.keys(row).length === 2 &&
    Object.keys(children).every((key) => childKeys.has(key)) &&
    (!Object.hasOwn(children, "ID") || validRegistryId(children.ID)) &&
    (!Object.hasOwn(children, "URL") || reportText(children.URL)) &&
    typeof children["Vulnerable Versions"] === "string" &&
    entriesMatch(children["Tree Versions"], version) &&
    entriesMatch(children.Dependents, locator)
  );
}

function keepAdvisory(found: Map<string, Advisory>, advisory: Advisory): void {
  const previous = found.get(advisory.id);
  if (!previous || severities.indexOf(previous.severity) < severities.indexOf(advisory.severity)) {
    found.set(advisory.id, advisory);
  }
}

function readReport(stdout: string) {
  const advisories = new Map<string, Advisory>();
  const treeKeys = new Set<string>();
  const lines = stdout.split("\n");
  let incomplete = lines.at(-1) !== "";
  if (!incomplete) lines.pop();
  let hasObject = false;
  let hasRow = false;
  for (const line of lines) {
    const row = scannerObject(line);
    if (row) hasObject = true;
    if (!row || typeof row.value !== "string" || !scannerRecord(row.children)) {
      incomplete = true;
      continue;
    }
    hasRow = true;
    const advisory = readAdvisory(row.value, row.children);
    if (advisory) keepAdvisory(advisories, advisory);
    if (!advisory || !completeRow(row, row.children)) {
      incomplete = true;
      continue;
    }
    // Yarn builds its tree with one entry per package and registry advisory ID.
    const key = `${row.value}/${String(row.children.ID)}`;
    if (treeKeys.has(key)) incomplete = true;
    treeKeys.add(key);
  }
  return {
    advisories: [...advisories.values()].sort((a, b) => a.id.localeCompare(b.id)),
    hasObject,
    hasRow,
    incomplete,
  };
}

function failedRun(evidence: YarnAuditEvidence): string | undefined {
  if (evidence.error !== undefined) return "Yarn audit did not complete";
  if (evidence.exitCode === null) return "Yarn audit stopped without an exit status";
  if (evidence.exitCode !== 0 && evidence.exitCode !== 1) {
    return `Yarn audit failed with exit code ${evidence.exitCode}`;
  }
  if (evidence.stderr !== "") return "Yarn audit reported unexpected stderr output";
  return undefined;
}

/**
 * Read the Yarn 4.17.0 audit tree NDJSON. The caller establishes the tool version and audit scope.
 * Yarn suppresses its clean message in JSON mode and emits one newline-terminated row per finding.
 * The caller verifies the clean text result before it uses complete-empty as coverage evidence.
 * See https://github.com/yarnpkg/berry/blob/%40yarnpkg/cli/4.17.0/packages/plugin-npm-cli/sources/commands/npm/audit.ts
 */
export function readYarnAuditEvidence(evidence: YarnAuditEvidence): YarnAuditOutcome {
  const { advisories, hasObject, hasRow, incomplete } = readReport(evidence.stdout);
  const failure = failedRun(evidence);
  if (failure) {
    return {
      advisories,
      error: failure,
      evidenceStatus: advisories.length ? "partial" : "unavailable",
    };
  }
  if (evidence.exitCode === 0 && evidence.stdout === "") {
    return { advisories, evidenceStatus: "complete-empty" };
  }
  if (evidence.exitCode === 1 && !hasObject) {
    return {
      advisories,
      error: "Yarn audit exited without a report",
      evidenceStatus: "unavailable",
    };
  }
  if (!hasRow) {
    return {
      advisories,
      error: "Yarn audit returned invalid report rows",
      evidenceStatus: "malformed",
    };
  }
  if (evidence.exitCode !== 1 || incomplete) {
    return {
      advisories,
      error: "Yarn audit rows or exit status do not establish complete coverage",
      evidenceStatus: "partial",
    };
  }
  return { advisories, evidenceStatus: "complete" };
}
