/** Evaluate standards measurements against thresholds and accepted baseline magnitudes. */
import { BASELINE_FILE } from "./baseline.js";
import { scanGeneral, type GeneralScan } from "./standards-general-scan.js";
export {
  scanGeneral,
  parseLizardCsv,
  parseJscpdReport,
  parseSccByFile,
} from "./standards-general-scan.js";
export type {
  GeneralScan,
  ComplexityFinding,
  DuplicationReport,
  SizeFinding,
} from "./standards-general-scan.js";

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
   * Not a clean skip. Reported separately in the summary and escalated to `fail`
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

// ── Result assembly (thresholds + baseline → StandardsCheckResult) ─────────────

const REL = (cwd: string, p: string): string => {
  const norm = p.startsWith(cwd) ? p.slice(cwd.length).replace(/^[/\\]+/, "") : p;
  return norm || p;
};

/** Stable baseline key for a complexity finding. */
export const complexityKey = (f: {
  file: string;
  fn: string;
  metricVersion?: string;
  identity?: string;
  anchor?: string;
}): string =>
  f.metricVersion ? `${f.metricVersion}:${f.file}:${f.anchor ?? f.identity}` : `${f.file}:${f.fn}`;
/** Frozen magnitude for a known complexity finding; stored beside its identity key. */
export const complexityMetricKey = (f: {
  file: string;
  fn: string;
  ccn: number;
  length: number;
  metricVersion?: string;
  identity?: string;
  anchor?: string;
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

function didNotRunResult(
  name: string,
  tool: string,
  enforce: boolean,
  issue?: string,
): StandardsCheckResult {
  return {
    category: "standards",
    dimension: "general",
    name,
    status: enforce ? "fail" : "warn",
    severity: enforce ? "high" : "low",
    didNotRun: true,
    detail:
      issue ??
      `${tool} not installed. This general gate did not run. Provision the tool before verification. Use --enforce to fail on incomplete analysis.`,
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
  const name = `complexity (${scan.engines ?? "lizard"})`;
  if (scan.didNotRun) {
    return didNotRunResult(name, "complexity scanner", enforce, scan.issue);
  }
  const over = scan.findings
    .map((finding) => ({ ...finding, file: REL(cwd, finding.file) }))
    .filter(
      (finding) =>
        finding.ccn > thresholds.maxComplexity ||
        (finding.kind !== "module" && finding.length > thresholds.maxFunctionLines),
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
    name,
    total: over.length,
    fresh: fresh.length,
    enforce,
    passDetail: `measured bodies within CCN ${thresholds.maxComplexity}; functions within ${thresholds.maxFunctionLines} lines`,
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
  if (scan.didNotRun) return didNotRunResult("duplication (jscpd)", "jscpd", enforce, scan.issue);
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
  if (scan.didNotRun) return didNotRunResult("file size (scc)", "scc", enforce, scan.issue);
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
 * Collect current general findings for a baseline. Refuse incomplete analysis before publication.
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
  if (scan.complexity.didNotRun || scan.duplication.didNotRun || scan.size.didNotRun) {
    throw new Error(
      "Cannot freeze standards while general analysis is incomplete. The existing baseline is unchanged.",
    );
  }
  const complexity = scan.complexity.didNotRun
    ? []
    : scan.complexity.findings
        .map((f) => ({ ...f, file: REL(cwd, f.file) }))
        .filter(
          (f) => f.ccn > t.maxComplexity || (f.kind !== "module" && f.length > t.maxFunctionLines),
        )
        .map(complexityKey);
  const complexityMetrics = scan.complexity.didNotRun
    ? []
    : scan.complexity.findings
        .map((f) => ({ ...f, file: REL(cwd, f.file) }))
        .filter(
          (f) => f.ccn > t.maxComplexity || (f.kind !== "module" && f.length > t.maxFunctionLines),
        )
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
