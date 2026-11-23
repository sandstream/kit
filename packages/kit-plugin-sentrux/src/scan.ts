/**
 * Sentrux architecture-scan ingestion. Read-only by design: this plugin NEVER
 * runs Sentrux's write paths and NEVER sends data anywhere.
 *
 * The operator saves JSON produced outside Kit, such as the JSON text in the
 * Sentrux MCP check_rules response. Kit reads it and records architecture
 * findings in its local scan-results log.
 *
 * Sentrux gives kit an axis it otherwise lacks: architectural decay (modularity,
 * acyclicity, depth, equality, redundancy → a 0–10000 health score) plus a
 * baseline gate and rule violations. It's deterministic, zero-LLM, single-binary
 * — the same shape as Socket/Semgrep — so it folds into kit's orchestrate-and-
 * gate model without changing kit's identity.
 */

import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";

const SCAN_RESULTS_FILE = ".kit-scan-results.jsonl";

export type Severity = "low" | "medium" | "high" | "critical";

export interface SentruxViolation {
  /** Rule id / name from `.sentrux/rules.toml` (or a synthetic id). */
  rule: string;
  severity: Severity;
  message: string;
  file?: string;
  files?: string[];
}

export interface SentruxRuleCoverage {
  checkedRules?: number;
  definedRules?: number;
  reportedViolations?: number;
}

export interface SentruxResult {
  /** Overall architecture health score (0–10000; higher = healthier). */
  score?: number;
  /** Did the quality gate pass (vs baseline)? */
  gatePassed: boolean;
  /** Per-metric breakdown: modularity, acyclicity, depth, equality, redundancy. */
  metrics: Record<string, number>;
  violations: SentruxViolation[];
  coverage?: "partial";
  ruleCoverage?: SentruxRuleCoverage;
}

/** Coerce an arbitrary severity string to kit's 4-level scale (default medium). */
function normalizeSeverity(raw: unknown): Severity {
  const s = typeof raw === "string" ? raw.toLowerCase() : "";
  if (s === "critical" || s === "crit" || s === "blocker") return "critical";
  if (s === "high" || s === "error" || s === "major") return "high";
  if (s === "low" || s === "info" || s === "minor" || s === "note") return "low";
  return "medium";
}

/**
 * Parse a saved Sentrux JSON report.
 * Tolerant of field-name variation across versions: score may be `score`,
 * `architecture_score`, or `total`; the gate flag may be `gate.passed`,
 * `passed`, `ok`, or native `pass`; violations may be `violations` or `issues`.
 */
function readSentruxReport(text: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    // `cause` keeps the parser's own diagnostic (offset, token) attached: a scanner that
    // loses WHY it could not read its input turns "cannot verify" into an opaque failure.
    throw new Error(`Invalid Sentrux JSON: ${err instanceof Error ? err.message : err}`, {
      cause: err,
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Invalid Sentrux report: expected a JSON object");
  return parsed as {
    score?: number;
    architecture_score?: number;
    total?: number;
    passed?: boolean;
    pass?: unknown;
    ok?: boolean;
    rules_checked?: unknown;
    violation_count?: unknown;
    truncated?: unknown;
    gate?: { passed?: boolean };
    metrics?: Record<string, number>;
    violations?: unknown[];
    issues?: unknown[];
  };
}

function readSentruxGate(r: ReturnType<typeof readSentruxReport>) {
  const flags = [r.gate?.passed, r.passed, r.ok, r.pass].filter((value) => value !== undefined);
  const passed = flags.find((value) => typeof value === "boolean");
  return {
    passed,
    failed: flags.includes(false),
    conflicting: flags.some((value) => value !== passed),
  };
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function nativeRulePassed(violations: SentruxViolation[]): boolean {
  return !violations.some(({ severity }) => severity === "high" || severity === "critical");
}

function ruleEvidence(r: ReturnType<typeof readSentruxReport>, violations: SentruxViolation[]) {
  if (
    r.pass === undefined &&
    r.rules_checked === undefined &&
    r.violation_count === undefined &&
    r.truncated === undefined
  )
    return { partial: false };
  const checkedRules = count(r.rules_checked);
  const reportedViolations = count(r.violation_count);
  const definedRules = count(record(r.truncated)?.total_rules_defined);
  const ruleCoverage = { checkedRules, reportedViolations, definedRules };
  const partial =
    r.pass !== nativeRulePassed(violations) ||
    !checkedRules ||
    reportedViolations !== violations.length ||
    r.truncated !== undefined;
  return { partial, ruleCoverage };
}

function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function hasInvalidViolationMetadata(raw: unknown): boolean {
  const value = record(raw);
  if (!value) return false;
  const severity = value.severity ?? value.level;
  if (severity !== undefined && typeof severity !== "string") return true;
  if (value.files === undefined) return false;
  return !Array.isArray(value.files) || !value.files.every(nonemptyString);
}

function readViolation(raw: unknown): SentruxViolation[] {
  const value = record(raw);
  if (!value) return [];
  const rule = [value.rule, value.id, value.name].find(nonemptyString);
  const message = [value.message, value.description].find(nonemptyString);
  if (!rule && !message) return [];
  const files = Array.isArray(value.files) ? value.files.filter(nonemptyString) : undefined;
  const file = [value.file, value.path, files?.[0]].find(nonemptyString);
  return [
    {
      rule: rule ?? "sentrux-rule",
      severity: normalizeSeverity(value.severity ?? value.level),
      message: message ?? "(no message)",
      file,
      ...(files ? { files } : {}),
    },
  ];
}

function readViolations(raw: unknown) {
  if (!Array.isArray(raw)) return { entries: [], partial: true };
  const entries = raw.flatMap(readViolation);
  return {
    entries,
    partial: raw.length !== entries.length || raw.some(hasInvalidViolationMetadata),
  };
}

export function parseSentruxJson(text: string): SentruxResult {
  const r = readSentruxReport(text);
  const gate = readSentruxGate(r);
  const violations = readViolations(r.violations === undefined ? r.issues : r.violations);
  const native = ruleEvidence(r, violations.entries);
  const partial = violations.partial || gate.conflicting || native.partial;
  if (partial && violations.entries.length === 0 && !gate.failed) {
    throw new Error("Invalid Sentrux report: no complete violation list or failing gate verdict");
  }
  const gatePassed = !gate.failed && (gate.passed ?? violations.entries.length === 0);
  return {
    score: r.score ?? r.architecture_score ?? r.total,
    gatePassed: !partial && gatePassed,
    metrics: r.metrics ?? {},
    violations: violations.entries,
    ...(native.ruleCoverage ? { ruleCoverage: native.ruleCoverage } : {}),
    ...(partial ? { coverage: "partial" as const } : {}),
  };
}

/**
 * Append Sentrux findings to .kit-scan-results.jsonl — one entry per rule
 * violation so `kit check --security` can filter by severity. If the gate failed
 * but the tool reported no discrete violations, emit one synthetic finding so a
 * gate failure never passes silently.
 */
export async function recordSentruxFindings(
  result: SentruxResult,
  cwd: string = process.cwd(),
): Promise<{ written: number } & Pick<SentruxResult, "coverage" | "ruleCoverage">> {
  const path = resolve(cwd, SCAN_RESULTS_FILE);
  const now = new Date().toISOString();
  const lines: string[] = [];
  const evidence = {
    ...(result.coverage ? { coverage: result.coverage } : {}),
    ...(result.ruleCoverage ? { ruleCoverage: result.ruleCoverage } : {}),
  };

  for (const v of result.violations) {
    lines.push(
      JSON.stringify({
        timestamp: now,
        source: "sentrux",
        severity: v.severity,
        id: v.rule,
        title: v.message,
        file: v.file,
        files: v.files,
        score: result.score,
        ...evidence,
      }),
    );
  }

  if (!result.gatePassed && result.violations.length === 0) {
    lines.push(
      JSON.stringify({
        timestamp: now,
        source: "sentrux",
        severity: "high",
        id: "sentrux-gate",
        title: `architecture gate failed${result.score != null ? ` (score ${result.score})` : ""}`,
        score: result.score,
        ...evidence,
      }),
    );
  }

  if (lines.length === 0) return { written: 0, ...evidence };
  await appendFile(path, lines.join("\n") + "\n", "utf-8");
  return { written: lines.length, ...evidence };
}
