/**
 * Sentrux architecture-scan ingestion. Read-only by design: this plugin NEVER
 * runs Sentrux's write paths and NEVER sends data anywhere.
 *
 * The operator runs Sentrux in their own env — `sentrux check . --json` (or
 * `sentrux gate --json`, which compares against a stored baseline) — exactly the
 * way the Snyk plugin consumes `snyk test --json`. kit just reads that JSON and
 * surfaces the architecture findings to its own scan-results log so
 * `kit check --security` can gate on them.
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
}

/** Coerce an arbitrary severity string to kit's 4-level scale (default medium). */
function normalizeSeverity(raw: unknown): Severity {
  const s = String(raw ?? "").toLowerCase();
  if (s === "critical" || s === "crit" || s === "blocker") return "critical";
  if (s === "high" || s === "error" || s === "major") return "high";
  if (s === "low" || s === "info" || s === "minor" || s === "note") return "low";
  return "medium";
}

/**
 * Parse a saved Sentrux JSON report.
 * Tolerant of field-name variation across versions: score may be `score`,
 * `architecture_score`, or `total`; the gate flag may be `gate.passed`,
 * `passed`, or `ok`; violations may be `violations` or `issues`.
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
    ok?: boolean;
    gate?: { passed?: boolean };
    metrics?: Record<string, number>;
    violations?: unknown[];
    issues?: unknown[];
  };
}

function readSentruxGate(r: ReturnType<typeof readSentruxReport>) {
  const flags = [r.gate?.passed, r.passed, r.ok].filter((value) => value !== undefined);
  const passed = flags.find((value) => typeof value === "boolean");
  return {
    passed,
    failed: flags.includes(false),
    conflicting: flags.some((value) => value !== passed),
  };
}

export function parseSentruxJson(text: string): SentruxResult {
  const r = readSentruxReport(text);
  const gate = readSentruxGate(r);
  const raw = r.violations === undefined ? r.issues : r.violations;
  const violations = Array.isArray(raw) ? raw.flatMap(readViolation) : [];
  const partial = !Array.isArray(raw) || raw.length !== violations.length || gate.conflicting;
  if (partial && violations.length === 0 && !gate.failed) {
    throw new Error("Invalid Sentrux report: no complete violation list or failing gate verdict");
  }

  return {
    score: r.score ?? r.architecture_score ?? r.total,
    gatePassed: !gate.failed && (gate.passed ?? violations.length === 0),
    metrics: r.metrics ?? {},
    violations,
    ...(partial ? { coverage: "partial" as const } : {}),
  };
}

function readViolation(raw: unknown): SentruxViolation[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const value = raw as Record<string, unknown>;
  const rule = value.rule ?? value.id ?? value.name;
  const message = value.message ?? value.description;
  if (typeof rule !== "string" && typeof message !== "string") return [];
  const file = value.file ?? value.path;
  return [
    {
      rule: typeof rule === "string" ? rule : "sentrux-rule",
      severity: normalizeSeverity(value.severity ?? value.level),
      message: typeof message === "string" ? message : "(no message)",
      file: typeof file === "string" ? file : undefined,
    },
  ];
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
): Promise<{ written: number; coverage?: "partial" }> {
  const path = resolve(cwd, SCAN_RESULTS_FILE);
  const now = new Date().toISOString();
  const lines: string[] = [];

  for (const v of result.violations) {
    lines.push(
      JSON.stringify({
        timestamp: now,
        source: "sentrux",
        severity: v.severity,
        id: v.rule,
        title: v.message,
        file: v.file,
        score: result.score,
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
      }),
    );
  }

  if (lines.length === 0) return { written: 0 };
  await appendFile(path, lines.join("\n") + "\n", "utf-8");
  return { written: lines.length, ...(result.coverage ? { coverage: result.coverage } : {}) };
}
