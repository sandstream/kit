/**
 * kit standards — a deterministic dev-standards gate (the third quality dimension
 * alongside `kit check` security and `kit design`).
 *
 * P1 covers the GENERAL gate: cross-cutting, language-agnostic code-quality
 * metrics measured the SAME way on every stack, so one implementation covers all
 * languages. Each dimension delegates to a real multi-language tool run in
 * report mode and thresholds the result:
 *
 *   - complexity   → lizard  (cyclomatic complexity + function length, many langs)
 *   - duplication  → jscpd   (% duplicated blocks + the offending file pairs)
 *   - size / shape → scc     (per-file line counts → god-file detection)
 *
 * Principles inherited from kit (non-negotiable):
 *   - Zero-LLM / deterministic: every gate is a metric with a threshold, never a
 *     model's judgment. Enforced by the no-restricted-imports boundary test.
 *   - Baseline-aware: a brownfield repo gates only on NET-NEW findings — the same
 *     `.kit-baseline.json` pattern as tests/design.
 *   - Warn by default, fail under `--enforce`: findings warn until CI opts in, so
 *     the gate is adoptable on an existing repo. A tool that could not RUN
 *     (`didNotRun`) is an honest SETUP GAP (a warn), escalated to a hard fail only
 *     under `--enforce` — fail-closed for CI, quiet for local first-runs.
 *
 * The tool INVOCATION is separated from the pure PARSERS (parseLizardCsv,
 * parseJscpdReport, parseSccByFile) so the parsing — the part with real logic —
 * is unit-tested against fixture output with no tool installed.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASELINE_FILE } from "./baseline.js";
import { resolveToolBin } from "./utils/resolveTool.js";
import { execFileNoThrow } from "./utils/execFileNoThrow.js";

export interface StandardsCheckResult {
  category: "standards";
  /** general = cross-cutting metric; specific = per-language linter (P2);
   *  plugin = user rule (P3); platform = deploy-surface gate e.g. container (P4). */
  dimension: "general" | "specific" | "plugin" | "platform";
  name: string;
  status: "pass" | "fail" | "warn" | "skip";
  severity?: "high" | "medium" | "low";
  detail: string;
  /**
   * True when the gate's tool could NOT run (binary absent, crashed). A setup gap,
   * NOT a clean skip — surfaced separately in the summary and escalated to `fail`
   * under `--enforce` (fail-closed for CI). Mirrors SecurityCheckResult.didNotRun.
   */
  didNotRun?: boolean;
  files?: string[];
}

export interface StandardsThresholds {
  /** Max cyclomatic complexity (CCN) per function before it's flagged. */
  maxComplexity: number;
  /** Max function length in lines. */
  maxFunctionLines: number;
  /** Max file length in lines (god-file detection). */
  maxFileLines: number;
  /** Max overall duplicated-block percentage. */
  maxDuplicationPct: number;
}

/**
 * Conservative defaults so a HEALTHY real-world repo scores well and only genuine
 * smells flag (calibrated against the compatibility corpus). Overridable via
 * `[standards.general]` in .kit.toml.
 */
export const DEFAULT_STANDARDS_THRESHOLDS: StandardsThresholds = {
  maxComplexity: 15,
  maxFunctionLines: 80,
  maxFileLines: 600,
  maxDuplicationPct: 5,
};

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
  /** Offending file pairs (deduped, sorted) — the baseline unit. */
  pairs: string[];
}

/**
 * Parse a jscpd JSON report (`--reporters json`). Reads
 * `statistics.total.percentage` and the `duplicates[]` list of clone file pairs.
 * Tolerant of missing fields (an empty report ⇒ 0% / no pairs). Pure.
 */
export function parseJscpdReport(jsonText: string): DuplicationReport {
  let data: unknown;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return { percentage: 0, pairs: [] };
  }
  const root = (data ?? {}) as Record<string, unknown>;
  const stats = (root.statistics ?? {}) as Record<string, unknown>;
  const total = (stats.total ?? {}) as Record<string, unknown>;
  const percentage = typeof total.percentage === "number" ? total.percentage : 0;

  const dupes = Array.isArray(root.duplicates) ? root.duplicates : [];
  const pairSet = new Set<string>();
  for (const d of dupes) {
    const dup = (d ?? {}) as Record<string, unknown>;
    const first = (dup.firstFile ?? {}) as Record<string, unknown>;
    const second = (dup.secondFile ?? {}) as Record<string, unknown>;
    const a = typeof first.name === "string" ? first.name : undefined;
    const b = typeof second.name === "string" ? second.name : undefined;
    if (a && b) pairSet.add([a, b].sort().join("|"));
  }
  return { percentage, pairs: [...pairSet].sort() };
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
  let data: unknown;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: SizeFinding[] = [];
  for (const lang of data) {
    const l = (lang ?? {}) as Record<string, unknown>;
    const files = Array.isArray(l.Files) ? l.Files : [];
    for (const f of files) {
      const file = (f ?? {}) as Record<string, unknown>;
      const location = typeof file.Location === "string" ? file.Location : undefined;
      const lines = typeof file.Lines === "number" ? file.Lines : undefined;
      if (location && typeof lines === "number") out.push({ file: location, lines });
    }
  }
  return out;
}

// ── Tool runners (resolve → exec → parse) ──────────────────────────────────────

/** Raw findings from the three general tools, or `didNotRun` when a tool is absent. */
export interface GeneralScan {
  complexity: { findings: ComplexityFinding[]; didNotRun: boolean };
  duplication: { report: DuplicationReport; didNotRun: boolean };
  size: { findings: SizeFinding[]; didNotRun: boolean };
}

async function runLizard(
  cwd: string,
): Promise<{ findings: ComplexityFinding[]; didNotRun: boolean }> {
  const bin = await resolveToolBin("lizard");
  if (!bin) return { findings: [], didNotRun: true };
  const args = ["--csv"];
  for (const d of EXCLUDE_DIRS) args.push("-x", `*/${d}/*`);
  args.push(cwd);
  const r = await execFileNoThrow(bin, args, { timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  // lizard exits non-zero when thresholds are exceeded but still prints the CSV;
  // treat "no parseable output at all" as a real failure to run.
  const findings = parseLizardCsv(r.stdout);
  if (!r.ok && findings.length === 0 && !r.stdout.trim()) return { findings: [], didNotRun: true };
  return { findings, didNotRun: false };
}

async function runJscpd(cwd: string): Promise<{ report: DuplicationReport; didNotRun: boolean }> {
  const bin = await resolveToolBin("jscpd");
  if (!bin) return { report: { percentage: 0, pairs: [] }, didNotRun: true };
  const outDir = mkdtempSync(join(tmpdir(), "kit-jscpd-"));
  try {
    const args = ["--silent", "--reporters", "json", "--output", outDir];
    for (const d of EXCLUDE_DIRS) args.push("--ignore", `**/${d}/**`);
    args.push(cwd);
    await execFileNoThrow(bin, args, { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
    let reportText: string;
    try {
      reportText = readFileSync(join(outDir, "jscpd-report.json"), "utf8");
    } catch {
      // No report file written ⇒ jscpd never produced output ⇒ did not run.
      return { report: { percentage: 0, pairs: [] }, didNotRun: true };
    }
    return { report: parseJscpdReport(reportText), didNotRun: false };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

async function runScc(cwd: string): Promise<{ findings: SizeFinding[]; didNotRun: boolean }> {
  const bin = await resolveToolBin("scc");
  if (!bin) return { findings: [], didNotRun: true };
  const args = ["--by-file", "--format", "json"];
  for (const d of EXCLUDE_DIRS) args.push("--exclude-dir", d);
  args.push(cwd);
  const r = await execFileNoThrow(bin, args, { timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
  if (!r.ok && !r.stdout.trim()) return { findings: [], didNotRun: true };
  return { findings: parseSccByFile(r.stdout), didNotRun: false };
}

export async function scanGeneral(cwd: string): Promise<GeneralScan> {
  const [complexity, duplication, size] = await Promise.all([
    runLizard(cwd),
    runJscpd(cwd),
    runScc(cwd),
  ]);
  return { complexity, duplication, size };
}

// ── Result assembly (thresholds + baseline → StandardsCheckResult) ─────────────

const REL = (cwd: string, p: string): string => {
  const norm = p.startsWith(cwd) ? p.slice(cwd.length).replace(/^[/\\]+/, "") : p;
  return norm || p;
};

/** Stable baseline key for a complexity finding. */
export const complexityKey = (f: { file: string; fn: string }): string => `${f.file}:${f.fn}`;
/** Frozen magnitude for a known complexity finding; stored beside its identity key. */
export const complexityMetricKey = (f: {
  file: string;
  fn: string;
  ccn: number;
  length: number;
}): string => `${complexityKey(f)}|ccn=${f.ccn}|length=${f.length}`;
/** Stable baseline key for a size finding. */
export const sizeKey = (f: { file: string }): string => f.file;
/** Frozen magnitude for a known oversized file; stored beside its identity key. */
export const sizeMetricKey = (f: { file: string; lines: number }): string =>
  `${sizeKey(f)}|lines=${f.lines}`;

function complexityMetricMap(entries: string[]): Map<string, { ccn: number; length: number }> {
  const metrics = new Map<string, { ccn: number; length: number }>();
  for (const entry of entries) {
    const match = /^(.*)\|ccn=(\d+)\|length=(\d+)$/.exec(entry);
    if (!match) continue;
    const key = match[1]!;
    const previous = metrics.get(key);
    metrics.set(key, {
      ccn: Math.max(previous?.ccn ?? 0, Number(match[2])),
      length: Math.max(previous?.length ?? 0, Number(match[3])),
    });
  }
  return metrics;
}

function sizeMetricMap(entries: string[]): Map<string, number> {
  const metrics = new Map<string, number>();
  for (const entry of entries) {
    const match = /^(.*)\|lines=(\d+)$/.exec(entry);
    if (match) metrics.set(match[1]!, Number(match[2]));
  }
  return metrics;
}

function isGeneratedStandardsMetadata(file: string): boolean {
  const normalized = file.replaceAll("\\", "/");
  return normalized === BASELINE_FILE || normalized.endsWith(`/${BASELINE_FILE}`);
}

function didNotRunResult(name: string, tool: string, enforce: boolean): StandardsCheckResult {
  return {
    category: "standards",
    dimension: "general",
    name,
    status: enforce ? "fail" : "warn",
    severity: enforce ? "high" : "low",
    didNotRun: true,
    detail: `${tool} not installed — this general gate did not run (setup gap). Install it (mise) or run \`kit standards\` after provisioning; use --enforce to fail CI on setup gaps`,
  };
}

export interface CheckStandardsOptions {
  cwd?: string;
  enforce?: boolean;
  thresholds?: Partial<StandardsThresholds>;
  baseline?: {
    complexity?: string[];
    complexityMetrics?: string[];
    duplication?: string[];
    size?: string[];
    sizeMetrics?: string[];
  };
  /** Injected pre-computed scan (tests / reuse). Falls back to running the tools. */
  scan?: GeneralScan;
}

function complexityResult(
  scan: GeneralScan["complexity"],
  cwd: string,
  thresholds: StandardsThresholds,
  baseline: CheckStandardsOptions["baseline"],
  enforce: boolean,
): StandardsCheckResult {
  if (scan.didNotRun) return didNotRunResult("complexity (lizard)", "lizard", enforce);
  const over = scan.findings
    .map((finding) => ({ ...finding, file: REL(cwd, finding.file) }))
    .filter(
      (finding) =>
        finding.ccn > thresholds.maxComplexity || finding.length > thresholds.maxFunctionLines,
    );
  const seen = new Set(baseline?.complexity ?? []);
  const frozen = complexityMetricMap(baseline?.complexityMetrics ?? []);
  const ratcheted = (baseline?.complexityMetrics?.length ?? 0) > 0;
  const fresh = over.filter((finding) => {
    const key = complexityKey(finding);
    if (!seen.has(key)) return true;
    const metric = frozen.get(key);
    return metric ? finding.ccn > metric.ccn || finding.length > metric.length : ratcheted;
  });
  return buildResult({
    name: "complexity (lizard)",
    total: over.length,
    fresh: fresh.length,
    enforce,
    passDetail: `all functions within CCN ${thresholds.maxComplexity} / ${thresholds.maxFunctionLines} lines`,
    freshDetail: `${fresh.length} function(s) over CCN ${thresholds.maxComplexity} or ${thresholds.maxFunctionLines} lines`,
    files: fresh
      .slice(0, 10)
      .map(
        (finding) =>
          `${finding.file} :: ${finding.fn} (CCN ${finding.ccn}, ${finding.length} lines)`,
      ),
  });
}

function duplicationResult(
  scan: GeneralScan["duplication"],
  thresholds: StandardsThresholds,
  baseline: CheckStandardsOptions["baseline"],
  enforce: boolean,
): StandardsCheckResult {
  if (scan.didNotRun) return didNotRunResult("duplication (jscpd)", "jscpd", enforce);
  const { percentage, pairs } = scan.report;
  const seen = new Set(baseline?.duplication ?? []);
  const freshPairs = pairs.filter((pair) => !seen.has(pair));
  // The percentage is the gate and clone pairs are the baseline unit.
  const over = percentage > thresholds.maxDuplicationPct;
  return buildResult({
    name: "duplication (jscpd)",
    total: over ? Math.max(pairs.length, 1) : 0,
    fresh: over ? freshPairs.length || (pairs.length === 0 ? 1 : 0) : 0,
    enforce,
    passDetail: `${percentage.toFixed(1)}% duplicated (≤ ${thresholds.maxDuplicationPct}%)`,
    freshDetail: `${percentage.toFixed(1)}% duplicated (threshold ${thresholds.maxDuplicationPct}%), ${freshPairs.length} new clone pair(s)`,
    files: freshPairs.slice(0, 10),
  });
}

function sizeResult(
  scan: GeneralScan["size"],
  cwd: string,
  thresholds: StandardsThresholds,
  baseline: CheckStandardsOptions["baseline"],
  enforce: boolean,
): StandardsCheckResult {
  if (scan.didNotRun) return didNotRunResult("file size (scc)", "scc", enforce);
  const over = scan.findings
    .map((finding) => ({ ...finding, file: REL(cwd, finding.file) }))
    .filter((finding) => !isGeneratedStandardsMetadata(finding.file))
    .filter((finding) => finding.lines > thresholds.maxFileLines);
  const seen = new Set(baseline?.size ?? []);
  const frozen = sizeMetricMap(baseline?.sizeMetrics ?? []);
  const ratcheted = (baseline?.sizeMetrics?.length ?? 0) > 0;
  const fresh = over.filter((finding) => {
    const key = sizeKey(finding);
    if (!seen.has(key)) return true;
    // Changelog is deliberately append-only release history. Its identity stays
    // baselined, but growth is not code-shape regression.
    if (key === "CHANGELOG.md") return false;
    const lines = frozen.get(key);
    return lines !== undefined ? finding.lines > lines : ratcheted;
  });
  return buildResult({
    name: "file size (scc)",
    total: over.length,
    fresh: fresh.length,
    enforce,
    passDetail: `no file over ${thresholds.maxFileLines} lines`,
    freshDetail: `${fresh.length} file(s) over ${thresholds.maxFileLines} lines`,
    files: fresh.slice(0, 10).map((finding) => `${finding.file} (${finding.lines} lines)`),
  });
}

export async function checkStandards(
  opts: CheckStandardsOptions = {},
): Promise<StandardsCheckResult[]> {
  const cwd = opts.cwd ?? process.cwd();
  const enforce = opts.enforce ?? false;
  const t: StandardsThresholds = { ...DEFAULT_STANDARDS_THRESHOLDS, ...opts.thresholds };
  const scan = opts.scan ?? (await scanGeneral(cwd));
  return [
    complexityResult(scan.complexity, cwd, t, opts.baseline, enforce),
    duplicationResult(scan.duplication, t, opts.baseline, enforce),
    sizeResult(scan.size, cwd, t, opts.baseline, enforce),
  ];
}

/** Shared pass / baseline-frozen-warn / net-new-finding shaping (mirrors checkDesign). */
function buildResult(args: {
  name: string;
  total: number;
  fresh: number;
  enforce: boolean;
  passDetail: string;
  freshDetail: string;
  files: string[];
}): StandardsCheckResult {
  const base = { category: "standards", dimension: "general", name: args.name } as const;
  if (args.total === 0) {
    return { ...base, status: "pass", detail: args.passDetail };
  }
  if (args.fresh === 0) {
    return {
      ...base,
      status: "warn",
      severity: "low",
      detail: `${args.total} pre-existing finding(s) (baseline-frozen)`,
    };
  }
  return {
    ...base,
    status: args.enforce ? "fail" : "warn",
    severity: args.enforce ? "high" : "medium",
    detail: args.freshDetail,
    files: args.files,
  };
}

/**
 * Snapshot current general findings for `kit baseline freeze` — every over-threshold
 * function/file and every clone pair, so future runs gate only on net-new. Runs the
 * tools; if a tool is absent its slice is empty (nothing to freeze).
 */
export async function collectStandardsKeys(
  cwd: string = process.cwd(),
  thresholds?: Partial<StandardsThresholds>,
): Promise<{
  complexity: string[];
  complexityMetrics: string[];
  duplication: string[];
  size: string[];
  sizeMetrics: string[];
}> {
  const t: StandardsThresholds = { ...DEFAULT_STANDARDS_THRESHOLDS, ...thresholds };
  const scan = await scanGeneral(cwd);
  const complexity = scan.complexity.didNotRun
    ? []
    : scan.complexity.findings
        .map((f) => ({ ...f, file: REL(cwd, f.file) }))
        .filter((f) => f.ccn > t.maxComplexity || f.length > t.maxFunctionLines)
        .map(complexityKey);
  const complexityMetrics = scan.complexity.didNotRun
    ? []
    : scan.complexity.findings
        .map((f) => ({ ...f, file: REL(cwd, f.file) }))
        .filter((f) => f.ccn > t.maxComplexity || f.length > t.maxFunctionLines)
        .map(complexityMetricKey);
  const duplication = scan.duplication.didNotRun ? [] : scan.duplication.report.pairs;
  const size = scan.size.didNotRun
    ? []
    : scan.size.findings
        .map((f) => ({ ...f, file: REL(cwd, f.file) }))
        .filter((f) => !isGeneratedStandardsMetadata(f.file))
        .filter((f) => f.lines > t.maxFileLines)
        .map(sizeKey);
  const sizeMetrics = scan.size.didNotRun
    ? []
    : scan.size.findings
        .map((f) => ({ ...f, file: REL(cwd, f.file) }))
        .filter((f) => !isGeneratedStandardsMetadata(f.file))
        .filter((f) => f.lines > t.maxFileLines)
        .map(sizeMetricKey);
  return { complexity, complexityMetrics, duplication, size, sizeMetrics };
}
