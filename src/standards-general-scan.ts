/** Collect tool measurements and reject incomplete reports before threshold evaluation. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { resolveToolBin } from "./utils/resolveTool.js";
import { execFileNoThrow, failedDetail } from "./utils/execFileNoThrow.js";
import { scanJavaScript } from "./standards-javascript.js";
import { JAVASCRIPT_EXTENSIONS } from "./standards-javascript-files.js";
import { readLizardReport } from "./standards-lizard-report.js";
import { crossCheckScan, jscpdSourceCount } from "./standards-scan-coverage.js";

/** Directories every general tool should ignore (vendored / generated code). */
const EXCLUDE_DIRS = [
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  "vendor",
  "target",
  ".git",
  "coverage",
  "__pycache__",
  ".venv",
];

// ── Pure parsers (unit-tested against fixture output) ──────────────────────────

export interface ComplexityFinding {
  file: string;
  fn: string;
  ccn: number;
  length: number;
  kind?: "function" | "module" | "initializer" | "static-block";
  metricVersion?: string;
  identity?: string;
  /** Baseline identity that survives edits above the body: kind, name and same-name order. */
  anchor?: string;
}

/**
 * Parse `lizard --csv` output. Each row is one function; the columns are:
 *   nloc, CCN, token_count, param_count, length, location, file, function, long_name, start, end
 * (no header row). Quoted fields may contain commas, so split CSV-aware. Rows that
 * don't parse as a function line are skipped. Pure.
 */
export function parseLizardCsv(csv: string): ComplexityFinding[] {
  const out: ComplexityFinding[] = [];
  for (const raw of csv.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const cols = splitCsvRow(line);
    if (cols.length < 8) continue;
    const ccn = Number(cols[1]);
    const length = Number(cols[4]);
    const file = cols[6];
    const fn = cols[7];
    // A valid function row has numeric CCN/length and a non-numeric header field.
    if (!Number.isFinite(ccn) || !Number.isFinite(length) || !file) continue;
    out.push({ file, fn: fn || "(anonymous)", ccn, length });
  }
  return out;
}

/** Minimal CSV row splitter: handles double-quoted fields containing commas. */
function splitCsvRow(row: string): string[] {
  const cols: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (inQuotes) {
      if (ch === '"') {
        if (row[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      cols.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  cols.push(cur);
  return cols;
}

export interface DuplicationReport {
  /** Overall duplicated-lines percentage. */
  percentage: number;
  /** Sorted unique file pairs identify accepted duplication findings. */
  pairs: string[];
}

/**
 * Parse a jscpd JSON report (`--reporters json`). Reads
 * `statistics.total.percentage` and the `duplicates[]` list of clone file pairs.
 * Tolerant of missing fields (an empty report ⇒ 0% / no pairs). Pure.
 */
export function parseJscpdReport(jsonText: string): DuplicationReport {
  return readJscpdReport(jsonText) ?? { percentage: 0, pairs: [] };
}

function readJscpdReport(jsonText: string): DuplicationReport | null {
  let data: unknown;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return null;
  }
  const root = (data ?? {}) as Record<string, unknown>;
  const stats = (root.statistics ?? {}) as Record<string, unknown>;
  const total = (stats.total ?? {}) as Record<string, unknown>;
  const percentage = total.percentage;
  if (
    typeof percentage !== "number" ||
    !Number.isFinite(percentage) ||
    percentage < 0 ||
    percentage > 100 ||
    !Array.isArray(root.duplicates)
  )
    return null;
  const dupes = root.duplicates;
  const pairSet = new Set<string>();
  for (const d of dupes) {
    const pair = readClonePair(d);
    if (pair === null) return null;
    pairSet.add(pair);
  }
  return { percentage, pairs: [...pairSet].sort() };
}

function readClonePair(value: unknown): string | null {
  const dup = (value ?? {}) as Record<string, unknown>;
  const first = (dup.firstFile ?? {}) as Record<string, unknown>;
  const second = (dup.secondFile ?? {}) as Record<string, unknown>;
  const a = typeof first.name === "string" ? first.name : undefined;
  const b = typeof second.name === "string" ? second.name : undefined;
  return a && b ? [a, b].sort().join("|") : null;
}

export interface SizeFinding {
  file: string;
  lines: number;
}

/**
 * Parse `scc --by-file --format json` output: an array of per-language objects,
 * each with a `Files[]` array of `{ Location, Lines }`. Returns one entry per
 * source file with its line count. Tolerant of shape drift. Pure.
 */
export function parseSccByFile(jsonText: string): SizeFinding[] {
  return readSccByFile(jsonText) ?? [];
}

function readSccByFile(jsonText: string): SizeFinding[] | null {
  let data: unknown;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!Array.isArray(data)) return null;
  const out: SizeFinding[] = [];
  for (const lang of data) {
    const l = (lang ?? {}) as Record<string, unknown>;
    if (!Array.isArray(l.Files)) return null;
    const files = l.Files;
    for (const f of files) {
      const file = (f ?? {}) as Record<string, unknown>;
      const location = typeof file.Location === "string" ? file.Location : undefined;
      const lines = typeof file.Lines === "number" ? file.Lines : undefined;
      if (!location || typeof lines !== "number" || !Number.isSafeInteger(lines) || lines < 0) {
        return null;
      }
      out.push({ file: location, lines });
    }
  }
  return out;
}

// ── Tool runners (resolve → exec → parse) ──────────────────────────────────────

/** Raw findings from the three general tools, or `didNotRun` when a tool is absent. */
export interface GeneralScan {
  complexity: {
    findings: ComplexityFinding[];
    didNotRun: boolean;
    issue?: string;
    engines?: string;
  };
  duplication: { report: DuplicationReport; didNotRun: boolean; issue?: string; sources?: number };
  size: { findings: SizeFinding[]; didNotRun: boolean; issue?: string };
}

async function runLizard(cwd: string): Promise<GeneralScan["complexity"]> {
  const bin = await resolveToolBin("lizard");
  if (!bin) return { findings: [], didNotRun: true };
  // Kit applies its own thresholds. A nonzero exit now means incomplete analysis.
  const args = ["--csv", "--ignore_warnings", "-1"];
  for (const d of EXCLUDE_DIRS) args.push("-x", `*/${d}/*`);
  for (const extension of JAVASCRIPT_EXTENSIONS) args.push("-x", `*${extension}`);
  args.push(cwd);
  const r = await execFileNoThrow(bin, args, { timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  if (!r.ok || r.truncated || r.timedOut) {
    return {
      findings: [],
      didNotRun: true,
      issue: failedDetail("lizard did not complete its report", r),
    };
  }
  const findings = readLizardReport(r.stdout);
  return findings
    ? { findings, didNotRun: false }
    : {
        findings: [],
        didNotRun: true,
        issue: "lizard returned an invalid report. Complexity remains unverified.",
      };
}

async function runJscpd(cwd: string): Promise<GeneralScan["duplication"]> {
  const bin = await resolveToolBin("jscpd");
  if (!bin) return { report: { percentage: 0, pairs: [] }, didNotRun: true };
  const outDir = mkdtempSync(join(tmpdir(), "kit-jscpd-"));
  try {
    const config = join(outDir, "config.json");
    writeFileSync(config, "{}", { mode: 0o600 });
    const args = [
      "--silent",
      "--reporters",
      "json",
      "--output",
      outDir,
      "--config",
      config,
      "--threshold",
      "100",
      "--exit-code",
      "0",
    ];
    for (const d of EXCLUDE_DIRS) args.push("--ignore", `**/${d}/**`);
    args.push(cwd);
    const result = await execFileNoThrow(bin, args, {
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (!result.ok || result.truncated || result.timedOut) {
      return {
        report: { percentage: 0, pairs: [] },
        didNotRun: true,
        issue: failedDetail("jscpd did not complete its report", result),
      };
    }
    let reportText: string;
    try {
      reportText = readFileSync(join(outDir, "jscpd-report.json"), "utf8");
    } catch {
      // No report file written ⇒ jscpd never produced output ⇒ did not run.
      return { report: { percentage: 0, pairs: [] }, didNotRun: true };
    }
    const report = readJscpdReport(reportText);
    return report
      ? { report, didNotRun: false, sources: jscpdSourceCount(reportText) }
      : {
          report: { percentage: 0, pairs: [] },
          didNotRun: true,
          issue: "jscpd returned an invalid report. Duplication remains unverified.",
        };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

async function runScc(cwd: string): Promise<GeneralScan["size"]> {
  const bin = await resolveToolBin("scc");
  if (!bin) return { findings: [], didNotRun: true };
  const args = ["--by-file", "--format", "json"];
  for (const d of EXCLUDE_DIRS) args.push("--exclude-dir", d);
  args.push(cwd);
  const r = await execFileNoThrow(bin, args, { timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
  if (!r.ok || r.truncated || r.timedOut) {
    return {
      findings: [],
      didNotRun: true,
      issue: failedDetail("scc did not complete its report", r),
    };
  }
  const findings = readSccByFile(r.stdout);
  return findings
    ? { findings, didNotRun: false }
    : {
        findings: [],
        didNotRun: true,
        issue: "scc returned an invalid report. File size remains unverified.",
      };
}

export async function scanGeneral(cwd: string): Promise<GeneralScan> {
  const [lizard, javascript, duplication, size] = await Promise.all([
    runLizard(cwd),
    scanJavaScript(cwd),
    runJscpd(cwd),
    runScc(cwd),
  ]);
  const complexity = lizard.didNotRun
    ? lizard
    : javascript.didNotRun
      ? javascript
      : {
          findings: [
            ...lizard.findings.filter(
              (finding) => !JAVASCRIPT_EXTENSIONS.has(extname(finding.file).toLowerCase()),
            ),
            ...javascript.findings,
          ],
          didNotRun: false,
          engines: javascript.files.length ? "lizard + typescript" : "lizard",
        };
  return crossCheckScan({ complexity, duplication, size }, duplication.sources);
}
