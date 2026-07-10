/**
 * `kit triage skill` — SkillSpector (NVIDIA) delegate, Stage-1 ONLY: deterministic, NO LLM, NO egress.
 *
 * Design: `kit-research/docs/research/pillar-triage-skill-delegate-5.0.md`.
 *
 * kit does NOT reimplement NVIDIA's 68-pattern agent-skill scanner — it ORCHESTRATES it, the same way
 * `kit check` orchestrates bumblebee/trivy/semgrep. We run SkillSpector's STATIC Stage 1 (regex + AST
 * + offline OSV) and normalize its SARIF into kit's `SecurityCheckResult`, ATTRIBUTED to the source.
 * kit's own value is the governance layer (deterministic, no-egress, one unified verdict, audit) — not
 * the detection rules; borrowing an authoritative source's rules strengthens trust rather than diluting
 * it, provided the provenance stays visible.
 *
 * ZERO-LLM / NO-EGRESS INVARIANT — why this file is safe to ship in kit:
 *   SkillSpector's Stage 2 is an LLM pass that sends file contents to a provider; invoking it would
 *   break kit's no-egress charter. kit NEVER invokes Stage 2. This is enforced two ways, both testable:
 *     1. SCRUBBED ENV — every SKILLSPECTOR_ (and provider-API-key) var is stripped from the child env, so
 *        Stage 2 cannot silently activate from ambient config (`scrubbedEnv`).
 *     2. STATIC INVOCATION — we run a plain `scan … --format sarif` and read only Stage-1 SARIF.
 *   Fail-CLOSED: a missing binary or a scan error is a DEGRADED result (never a silent pass); the
 *   caller must not report "deep-clean" when the delegate did not actually run.
 *
 * Deterministic given (binary, target, env). Offline (Stage 1 uses OSV's offline fallback).
 */
import { resolveToolBin } from "./utils/resolveTool.js";
import { execFileNoThrow } from "./utils/execFileNoThrow.js";
import { parseSarif } from "./adapters/ingest.js";
import type { SecurityCheckResult } from "./check-security.js";

/** The delegate binary name (resolved mise-first, then PATH). */
export const SKILLSPECTOR_BIN = "skillspector";

/** Attribution stamped on every normalized finding so borrowed authority stays visible. */
export const SKILLSPECTOR_SOURCE = "SkillSpector (NVIDIA) Stage 1";

/**
 * Env vars that could switch SkillSpector's optional Stage-2 LLM on (or hand it a provider key). We
 * strip ALL of these from the child env so the delegate can only ever run its deterministic Stage 1 —
 * regardless of what the surrounding shell has exported.
 */
export const LLM_ENV_VARS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "OLLAMA_HOST",
];

/** Build a child env with every SKILLSPECTOR_* var and known provider key removed (no Stage-2 LLM). */
export function scrubbedEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (k.startsWith("SKILLSPECTOR_")) continue; // provider/model/config for Stage 2
    if (LLM_ENV_VARS.includes(k)) continue; // provider API keys
    out[k] = v;
  }
  // Belt-and-suspenders: pin the provider to empty so an internal default can't reach the network.
  out.SKILLSPECTOR_PROVIDER = "";
  return out;
}

/** Argv for a static, SARIF-emitting Stage-1 scan. No `--llm`/provider flags are ever added. */
export function stage1Args(target: string): string[] {
  return ["scan", target, "--format", "sarif"];
}

/**
 * Normalize SkillSpector SARIF into kit findings, tagged supply-chain and attributed to the source.
 * Pure — reuses the shared `parseSarif`. An empty/invalid SARIF yields `[]` (parseSarif never throws).
 */
export function normalizeSkillspectorSarif(sarifJson: string): SecurityCheckResult[] {
  return parseSarif(sarifJson).map((f) => ({
    ...f,
    category: "supply-chain",
    name: `${SKILLSPECTOR_SOURCE}: ${f.name.replace(/^[^:]+:\s*/, "")}`,
  }));
}

export type SkillspectorResult =
  | { status: "ok"; findings: SecurityCheckResult[]; worst: SecurityCheckResult["severity"] }
  | { status: "unavailable"; detail: string }
  | { status: "error"; detail: string };

const SEVERITY_RANK: Record<NonNullable<SecurityCheckResult["severity"]>, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

function worstSeverity(findings: SecurityCheckResult[]): SecurityCheckResult["severity"] {
  let worst: SecurityCheckResult["severity"] = undefined;
  for (const f of findings) {
    if (!f.severity) continue;
    if (!worst || SEVERITY_RANK[f.severity] > SEVERITY_RANK[worst]) worst = f.severity;
  }
  return worst;
}

/**
 * Run SkillSpector's Stage 1 on `target` and return normalized findings. Fail-CLOSED and never throws:
 *   - binary not installed        → { status: "unavailable" }  (caller must not claim deep-clean)
 *   - scan crashed (exit 2)       → { status: "error" }
 *   - scanned (exit 0 = clean, 1 = findings) → { status: "ok", findings }
 * Always runs with `scrubbedEnv` so Stage 2 can never activate.
 */
export async function runSkillspectorStage1(
  target: string,
  opts: { cwd?: string; timeout?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<SkillspectorResult> {
  const bin = await resolveToolBin(SKILLSPECTOR_BIN);
  if (!bin) {
    return {
      status: "unavailable",
      detail: `${SKILLSPECTOR_BIN} not installed — deep skill triage skipped (install to enable; kit never runs its LLM stage)`,
    };
  }
  const res = await execFileNoThrow(bin, stage1Args(target), {
    cwd: opts.cwd,
    timeout: opts.timeout ?? 120_000,
    env: scrubbedEnv(opts.env),
    maxBuffer: 8 * 1024 * 1024,
  });
  // SkillSpector exit codes: 0 = risk ≤ 50, 1 = risk > 50 (findings), 2 = error.
  if (res.exitCode === 2) {
    return { status: "error", detail: res.stderr.trim() || "skillspector scan errored" };
  }
  const findings = normalizeSkillspectorSarif(res.stdout);
  return { status: "ok", findings, worst: worstSeverity(findings) };
}
