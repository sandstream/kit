import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { ingestStrict } from "./adapters/ingest.js";
import { reportText, scannerObject, scannerRecord } from "./check-scanner-evidence.js";
import type { SecurityCheckResult } from "./check-security.js";
import type { ScannerEvidence, ScannerProcess } from "./scan-result.js";
import { readSemgrepDocument, semgrepFindingLevel } from "./semgrep-report.js";
import { readRegularFileBytesIfPresent } from "./upstream-safe-read.js";

const MAX_SARIF_BYTES = 64 * 1024 * 1024;
type Run = (args: string[], cwd: string) => Promise<ScannerProcess>;
type PartialEvidence = Extract<ScannerEvidence, { status: "partial" }>;
const priority = { note: 0, warning: 1, error: 2, critical: 3 } as const;
type Level = keyof typeof priority;

function partial(
  reason: string,
  reportGap: PartialEvidence["reportGap"] = "partial",
): PartialEvidence {
  return { status: "partial", reportGap, reason };
}

function fileInScope(root: string, name: string): boolean {
  if (name.split(/[\\/]/).includes("..")) return false;
  try {
    const path = realpathSync(resolve(root, name));
    const local = relative(root, path);
    return (
      local !== ".." &&
      !local.startsWith(".." + sep) &&
      !isAbsolute(local) &&
      statSync(path).isFile()
    );
  } catch {
    return false;
  }
}

type Location = { path: string; line?: number; column?: number };
type Match = Location & { id: string; level: Level };

function coordinate(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function pathKey(path: string): string {
  return path.replaceAll("\\", "/").replace(/^(?:\.\/)+/, "");
}

function nativeMatch(value: unknown): Match | undefined {
  if (!scannerRecord(value) || !scannerRecord(value.extra)) return undefined;
  const { check_id: id, path, start } = value;
  const kind = semgrepFindingLevel(value);
  if (!reportText(id) || !reportText(path) || !kind) return undefined;
  const level =
    kind === "blocking"
      ? value.extra.severity === "CRITICAL"
        ? "critical"
        : "error"
      : kind === "warning"
        ? "warning"
        : "note";
  return { id, path: pathKey(path), ...nativeCoordinates(start), level };
}

function nativeCoordinates(value: unknown): Omit<Location, "path"> {
  return scannerRecord(value)
    ? { line: coordinate(value.line), column: coordinate(value.col) }
    : {};
}

function sarifLocation(value: unknown): Location | undefined {
  if (!scannerRecord(value)) return undefined;
  const { artifactLocation, region } = value;
  if (!scannerRecord(artifactLocation) || !reportText(artifactLocation.uri)) return undefined;
  if (!scannerRecord(region)) return undefined;
  try {
    return {
      path: pathKey(decodeURI(artifactLocation.uri)),
      line: coordinate(region.startLine),
      column: coordinate(region.startColumn),
    };
  } catch {
    return undefined;
  }
}

function sarifMatch(value: unknown): Omit<Match, "level"> | undefined {
  if (!scannerRecord(value) || !reportText(value.ruleId) || !Array.isArray(value.locations))
    return undefined;
  const location = value.locations[0];
  if (!scannerRecord(location)) return undefined;
  const target = sarifLocation(location.physicalLocation);
  return target && { ...target, id: value.ruleId };
}

function key({ id, path, line, column }: Omit<Match, "level">): string {
  return JSON.stringify([id, path, line, column]);
}

const normalizedPriority = { critical: 3, high: 2, medium: 1, low: 0 } as const;
type Reconciliation = { missing: Match[]; complete: boolean };

function reconcile(
  native: Match[],
  runs: unknown[],
  normalized: SecurityCheckResult[],
): Reconciliation {
  if (!runs.length || !runs.every(semgrepRun)) return { missing: native, complete: false };
  const results = runs.flatMap((run) =>
    scannerRecord(run) && Array.isArray(run.results) ? run.results : [],
  );
  if (results.length !== normalized.length) return { missing: native, complete: false };
  const counts = new Map<string, number[]>();
  for (const [index, result] of results.entries()) {
    const match = sarifMatch(result);
    const severity = normalized[index]?.severity;
    if (!match || !severity) continue;
    const signature = key(match);
    const available = counts.get(signature) ?? [];
    available.push(normalizedPriority[severity]);
    counts.set(signature, available);
  }
  const missing = native.filter((match) => {
    if (match.line === undefined) return true;
    const available = counts.get(key(match)) ?? [];
    available.sort((left, right) => left - right);
    const found = available.findIndex((level) => level >= priority[match.level]);
    if (found < 0) return true;
    available.splice(found, 1);
    return false;
  });
  return { missing, complete: missing.length === 0 && results.length === native.length };
}

function fallbackRun(matches: Match[]) {
  return {
    tool: { driver: { name: "Semgrep" } },
    results: matches.map(({ id, path, line, column, level }) => ({
      ruleId: id,
      level: level === "critical" ? "error" : level,
      ...(level === "critical" ? { properties: { "security-severity": "9.5" } } : {}),
      message: { text: "Semgrep reported a rule finding" },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: path },
            ...(line === undefined ? {} : { region: { startLine: line, startColumn: column } }),
          },
        },
      ],
    })),
  };
}

function scopeEvidence(
  root: string,
  { coverage, document }: ReturnType<typeof readSemgrepDocument>,
  rows: (Match | undefined)[],
): ScannerEvidence {
  const scanned = scannerRecord(document?.paths) ? document.paths.scanned : undefined;
  if (coverage.gap === "missing" && Array.isArray(scanned) && !scanned.length && !rows.length)
    return { status: "not-applicable", reason: "Semgrep reported no scanned files" };
  if (coverage.gap)
    return partial(
      coverage.note ?? "Semgrep did not produce complete native coverage",
      coverage.gap === "unavailable" ? "partial" : coverage.gap,
    );
  const paths = new Set(Array.isArray(scanned) ? scanned.filter(reportText).map(pathKey) : []);
  if (
    ![...paths].every((path) => fileInScope(root, path)) ||
    rows.some((row) => !row || row.line === undefined || !paths.has(row.path))
  )
    return partial("Semgrep reported inconsistent or out-of-scope source paths");
  return { status: "complete", fileCount: paths.size };
}

function semgrepRun(run: unknown): boolean {
  if (!scannerRecord(run) || !scannerRecord(run.tool) || !scannerRecord(run.tool.driver))
    return false;
  const name = run.tool.driver.name;
  return typeof name === "string" && /^Semgrep(?:\s|$)/i.test(name);
}

function pairedOutput(root: string, native: string, sarif: string) {
  const read = readSemgrepDocument(native);
  const { document } = read;
  const rows = Array.isArray(document?.results) ? document.results.map(nativeMatch) : [];
  const evidence = scopeEvidence(root, read, rows);
  const checked = ingestStrict("sarif", sarif);
  const parsed = checked.ok ? scannerObject(sarif) : undefined;
  const runs = Array.isArray(parsed?.runs) ? parsed.runs : [];
  const paired = reconcile(
    rows.filter((row) => row !== undefined),
    runs,
    checked.ok && !checked.coverage ? checked.findings : [],
  );
  if (checked.ok && !checked.coverage && paired.complete) return { stdout: sarif, evidence };
  return {
    stdout: JSON.stringify({ version: "2.1.0", runs: [...runs, fallbackRun(paired.missing)] }),
    evidence:
      evidence.status === "partial" ? evidence : partial("Semgrep SARIF coverage was incomplete"),
  };
}

function readSarif(path: string): string {
  try {
    const bytes = readRegularFileBytesIfPresent(path, MAX_SARIF_BYTES);
    return bytes ? new TextDecoder("utf-8", { fatal: true }).decode(bytes) : "";
  } catch {
    return "";
  }
}

function removeWorkspace(path: string): boolean {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 3 });
    return true;
  } catch {
    return false;
  }
}

export async function runSemgrepWithCoverage(
  cwd: string,
  args: string[],
  run: Run,
): Promise<ScannerProcess> {
  let root: string;
  let work: string;
  try {
    root = realpathSync(cwd);
    work = mkdtempSync(join(tmpdir(), "kit-semgrep-report-"));
  } catch {
    return {
      ok: false,
      stdout: "",
      stderr: "Unable to prepare Semgrep report workspace",
      noNumericExitStatus: true,
    };
  }
  let output: ScannerProcess;
  let removed: boolean;
  try {
    const path = join(work, "report.sarif");
    writeFileSync(path, "", { flag: "wx", mode: 0o600 });
    const process = await run([...args, "--sarif-output", path], root);
    output = { ...process, ...pairedOutput(root, process.stdout, readSarif(path)) };
  } catch {
    output = {
      ok: false,
      stdout: "",
      stderr: "Unable to collect Semgrep reports",
      noNumericExitStatus: true,
    };
  } finally {
    removed = removeWorkspace(work);
  }
  return removed
    ? output
    : { ...output, evidence: partial("Semgrep report workspace cleanup failed") };
}
