import { mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { reportText, scannerObject, scannerRecord } from "./check-scanner-evidence.js";
import type { ScannerEvidence, ScannerProcess } from "./scan-result.js";
import { readRegularFileBytesIfPresent } from "./upstream-safe-read.js";

type SnykScope = { target: string; count: number; issues: Set<string> };
type CoverageGap = Extract<ScannerEvidence, { status: "partial" }>["reportGap"];
const OUTPUT_LIMIT = 64 * 1024 * 1024;

function gap(reportGap: CoverageGap, reason: string): ScannerEvidence {
  return { status: "partial", reportGap, reason };
}

function inside(root: string, file: string): boolean {
  const path = relative(root, file);
  return !!path && path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path);
}

function scopeTarget(root: string, directory: unknown, target: unknown): string | undefined {
  if (
    !reportText(directory) ||
    !isAbsolute(directory) ||
    !reportText(target) ||
    isAbsolute(target) ||
    win32.isAbsolute(target) ||
    /^[a-z]:/i.test(target) ||
    /[\u0000-\u001f\u007f]/.test(target) ||
    target.split(/[\\/]/u).includes("..")
  )
    return undefined;
  try {
    if (realpathSync(directory) !== root) return undefined;
    const path = realpathSync(resolve(root, target));
    return inside(root, path) && statSync(path).isFile() ? relative(root, path) : undefined;
  } catch {
    return undefined;
  }
}

function reportCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function issueIds(rows: unknown, key: "id" | "ruleId"): Set<string> | undefined {
  if (!Array.isArray(rows)) return undefined;
  const issues = new Set<string>();
  for (const row of rows) {
    if (!scannerRecord(row) || !reportText(row[key])) return undefined;
    issues.add(row[key]);
  }
  return issues;
}

function readScope(item: unknown, root: string): SnykScope | undefined {
  if (!scannerRecord(item) || !reportCount(item.dependencyCount) || item.error !== undefined)
    return undefined;
  if (item.hasUnknownVersions !== undefined && item.hasUnknownVersions !== false) return undefined;
  const target = scopeTarget(root, item.path, item.displayTargetFile);
  const issues = issueIds(item.vulnerabilities, "id");
  if (!target || !issues || item.ok !== (issues.size === 0)) return undefined;
  if (item.uniqueCount !== issues.size || (item.dependencyCount === 0 && issues.size > 0))
    return undefined;
  return { target, count: item.dependencyCount, issues };
}

function readSarifScope(run: unknown, scope: SnykScope): boolean {
  if (!scannerRecord(run) || !scannerRecord(run.tool) || !scannerRecord(run.tool.driver))
    return false;
  const { driver } = run.tool;
  if (driver.name !== "Snyk Open Source" || !scannerRecord(driver.properties)) return false;
  if (driver.properties.artifactsScanned !== scope.count) return false;
  const ids = issueIds(run.results, "ruleId");
  return ids?.size === scope.issues.size && [...ids].every((id) => scope.issues.has(id));
}

export function readSnykCoverage(
  text: string | null,
  stdout: string,
  root: string,
  exitCode: number | undefined,
): ScannerEvidence {
  if (text === null) return gap("missing", "Snyk coverage report is missing");
  let report: unknown;
  try {
    report = JSON.parse(text);
  } catch {
    return gap("malformed", "Snyk coverage report is not valid JSON");
  }
  if (!Array.isArray(report) && !scannerRecord(report))
    return gap("malformed", "Snyk coverage report has an invalid structure");
  const entries = Array.isArray(report) ? report : [report];
  const sarif = scannerObject(stdout);
  const runs = sarif?.runs;
  if (
    sarif?.version !== "2.1.0" ||
    !Array.isArray(runs) ||
    !entries.length ||
    runs.length !== entries.length
  )
    return gap("partial", "Snyk coverage and SARIF reports do not identify the same runs");
  return compareSnykReports(entries, runs, root, exitCode);
}

function compareSnykReports(
  entries: unknown[],
  runs: unknown[],
  root: string,
  exitCode: number | undefined,
): ScannerEvidence {
  const targets = new Set<string>();
  let packageCount = 0;
  let expectedExit = 0;
  for (const [index, entry] of entries.entries()) {
    const scope = readScope(entry, root);
    if (!scope || targets.has(scope.target) || !readSarifScope(runs[index], scope))
      return gap("partial", "Snyk could not verify the target, dependency count or issue IDs");
    targets.add(scope.target);
    packageCount += scope.count;
    if (scope.issues.size > 0) expectedExit = 1;
  }
  if (exitCode !== expectedExit)
    return gap("partial", "Snyk issue evidence does not match the scanner exit code");
  if (!reportCount(packageCount)) return gap("partial", "Snyk dependency count exceeds the limit");
  return { status: "complete", packageCount, targetFiles: [...targets] };
}

function reportEvidence(path: string, process: ScannerProcess, root: string): ScannerEvidence {
  try {
    const bytes = readRegularFileBytesIfPresent(path, OUTPUT_LIMIT);
    const text = bytes && new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return readSnykCoverage(text, process.stdout, root, process.exitCode);
  } catch {
    return gap("malformed", "Snyk coverage report could not be read");
  }
}

export async function runSnykWithCoverage(
  cwd: string,
  args: string[],
  run: (args: string[], cwd: string) => Promise<ScannerProcess>,
): Promise<ScannerProcess> {
  let root: string;
  let work: string;
  try {
    root = realpathSync(cwd);
    work = mkdtempSync(join(tmpdir(), "kit-snyk-coverage-"));
  } catch {
    return {
      ok: false,
      stdout: "",
      stderr: "Unable to prepare Snyk coverage workspace",
      noNumericExitStatus: true,
    };
  }
  let process: ScannerProcess;
  let cleanupFailed = false;
  try {
    const path = join(work, "scope.json");
    process = await run([...args, "--json-file-output=" + path], root);
    process = { ...process, evidence: reportEvidence(path, process, root) };
  } finally {
    try {
      rmSync(work, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      cleanupFailed = true;
    }
  }
  return cleanupFailed
    ? { ...process, evidence: gap("partial", "Snyk coverage workspace cleanup failed") }
    : process;
}
