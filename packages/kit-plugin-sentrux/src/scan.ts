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
 * Parse the JSON produced by `sentrux check --json` / `sentrux gate --json`.
 * Tolerant of field-name variation across versions: score may be `score`,
 * `architecture_score`, or `total`; the gate flag may be `gate.passed`,
 * `passed`, or `ok`; violations may be `violations` or `issues`. Missing fields
 * degrade gracefully rather than throwing.
 */
export function parseSentruxJson(text: string): SentruxResult {
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
  if (!parsed || typeof parsed !== "object") {
    return { gatePassed: true, metrics: {}, violations: [] };
  }
  const r = parsed as {
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

  const violationsRaw = Array.isArray(r.violations)
    ? r.violations
    : Array.isArray(r.issues)
      ? r.issues
      : [];
  const violations: SentruxViolation[] = violationsRaw.map((v) => {
    const o = (v ?? {}) as {
      rule?: string;
      id?: string;
      name?: string;
      severity?: string;
      level?: string;
      message?: string;
      description?: string;
      file?: string;
      path?: string;
    };
    return {
      rule: o.rule ?? o.id ?? o.name ?? "sentrux-rule",
      severity: normalizeSeverity(o.severity ?? o.level),
      message: o.message ?? o.description ?? "(no message)",
      file: o.file ?? o.path,
    };
  });

  const passed =
    typeof r.gate?.passed === "boolean"
      ? r.gate.passed
      : typeof r.passed === "boolean"
        ? r.passed
        : typeof r.ok === "boolean"
          ? r.ok
          : violations.length === 0; // no explicit flag → infer from violations

  return {
    score: r.score ?? r.architecture_score ?? r.total,
    gatePassed: passed,
    metrics: r.metrics ?? {},
    violations,
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
): Promise<{ written: number }> {
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
  return { written: lines.length };
}
