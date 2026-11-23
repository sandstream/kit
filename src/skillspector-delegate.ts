/** Run SkillSpector with its static analysis option and assess the returned SARIF. */
import { resolveToolBin } from "./utils/resolveTool.js";
import { execFileNoThrow, failedDetail } from "./utils/execFileNoThrow.js";
import { readSkillspectorReport, type SkillspectorReport } from "./skillspector-report.js";
import { sanitizeDisplayText } from "./display-text.js";
import type { SecurityCheckResult } from "./check-security.js";

/** The delegate binary name (resolved mise-first, then PATH). */
export const SKILLSPECTOR_BIN = "skillspector";

/** Attribution stamped on every normalized finding so borrowed authority stays visible. */
export { SKILLSPECTOR_SOURCE } from "./skillspector-report.js";

/**
 * Env vars that could switch SkillSpector's optional Stage-2 LLM on (or hand it a provider key). We
 * strip these from the child environment before we run the delegate.
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
  // Clear the inherited provider setting.
  out.SKILLSPECTOR_PROVIDER = "";
  return out;
}

/** Arguments for SARIF output with static analysis. */
export function stage1Args(target: string): string[] {
  return ["scan", target, "--format", "sarif", "--no-llm"];
}

export interface SkillspectorStatus {
  available: boolean;
  version?: string;
  detail: string;
}

/**
 * Detect whether the SkillSpector delegate is installed (mise-first, then PATH) and its version.
 * Run the version probe with the same environment filtering as the scan.
 */
export async function skillspectorStatus(): Promise<SkillspectorStatus> {
  const bin = await resolveToolBin(SKILLSPECTOR_BIN);
  if (!bin) {
    return {
      available: false,
      detail: `${SKILLSPECTOR_BIN} not installed. Install it for deep skill triage.`,
    };
  }
  const res = await execFileNoThrow(bin, ["--version"], { timeout: 10_000, env: scrubbedEnv() });
  if (!res.ok) {
    return { available: false, detail: failedDetail("SkillSpector version check failed", res) };
  }
  const line = (res.stdout.trim() || res.stderr.trim()).split("\n")[0] ?? "";
  const version = sanitizeDisplayText(line) || undefined;
  return { available: true, version, detail: version ? `available (${version})` : "available" };
}

export type SkillspectorResult =
  | (Extract<SkillspectorReport, { status: "ok" }> & { worst: SecurityCheckResult["severity"] })
  | Exclude<SkillspectorReport, { status: "ok" }>
  | {
      status: "unavailable" | "error" | "blocked";
      detail: string;
      findings: SecurityCheckResult[];
    };

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

/** Accept results only after the delegate reports complete static coverage. */
export async function runSkillspectorStage1(
  target: string,
  opts: { cwd?: string; timeout?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<SkillspectorResult> {
  const bin = await resolveToolBin(SKILLSPECTOR_BIN);
  if (!bin) {
    return {
      status: "unavailable",
      detail: `${SKILLSPECTOR_BIN} not installed. Install it for deep skill triage.`,
      findings: [],
    };
  }
  const res = await execFileNoThrow(bin, stage1Args(target), {
    cwd: opts.cwd,
    timeout: opts.timeout ?? 120_000,
    env: scrubbedEnv(opts.env),
    maxBuffer: 8 * 1024 * 1024,
  });
  const report = readSkillspectorReport(res.stdout);
  const { findings } = report;
  if (res.truncated || res.timedOut) {
    return {
      status: "partial",
      detail: failedDetail("SkillSpector did not complete", res),
      findings,
    };
  }
  if (res.noNumericExitStatus || (res.exitCode !== 0 && res.exitCode !== 1)) {
    const detail = res.noNumericExitStatus
      ? "SkillSpector stopped without returning an exit code."
      : `SkillSpector failed with exit code ${res.exitCode}.`;
    return { status: "error", detail, findings };
  }
  if (report.status !== "ok") return report;
  if (res.exitCode === 1) {
    return findings.length === 0
      ? {
          status: "malformed",
          detail: "SkillSpector blocked the scan without reporting findings.",
          findings,
        }
      : { status: "blocked", detail: "SkillSpector returned a blocking risk verdict.", findings };
  }
  return { ...report, worst: worstSeverity(findings) };
}
