/**
 * Triage — Security evaluation for open source packages, Docker images, skills, and repos.
 * Wraps the Python triage script and integrates with kit's check-security system.
 */

import { access, cp, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { triageNpmSandbox, type SandboxResult } from "./triage-sandbox.js";
import { exec } from "./utils/exec.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Where kit looks for the triage skill at runtime. */
const TRIAGE_SKILL_DIR = resolve(homedir(), ".claude/skills/triage");
const TRIAGE_SCRIPT = resolve(TRIAGE_SKILL_DIR, "scripts/triage.py");
/** The copy kit ships in its own package (published via package.json "files"). */
const BUNDLED_TRIAGE_SKILL = resolve(__dirname, "..", "skills", "triage");

/**
 * Self-bootstrap the gate: copy the triage skill kit ships with into
 * ~/.claude/skills/triage. Copying kit's OWN bundled, provenance-published asset
 * is not a third-party install, so it does not itself need triage. Returns true
 * if the script is in place afterwards.
 */
export async function installBundledTriageSkill(
  targetDir: string = TRIAGE_SKILL_DIR,
): Promise<boolean> {
  try {
    await mkdir(dirname(targetDir), { recursive: true });
    await cp(BUNDLED_TRIAGE_SKILL, targetDir, { recursive: true });
    await access(resolve(targetDir, "scripts/triage.py"));
    return true;
  } catch {
    return false;
  }
}

export type TriageType = "docker" | "npm" | "pip" | "repo" | "skill" | "all" | "tools";

export { triageNpmSandbox, type SandboxResult };

export interface TriageResult {
  target: string;
  type: TriageType;
  passed: boolean;
  output: string;
}

/**
 * Ensure the triage script is present. If it is missing, self-bootstrap from the
 * copy kit ships, so the watertight gate works on a fresh machine without a
 * manual "copy the triage skill" step.
 */
async function ensureTriageScript(): Promise<boolean> {
  try {
    await access(TRIAGE_SCRIPT);
    return true;
  } catch {
    return installBundledTriageSkill();
  }
}

/**
 * Decide PASS strictly from the triage script's verdict lines.
 *
 * SECURITY: the script echoes the (attacker-influenceable) target into its
 * output header, so a naive `output.includes("TRIAGE PASSED")` is FORGEABLE — a
 * target containing the literal `TRIAGE PASSED` (or an embedded newline that
 * starts such a line) would forge a pass and defeat "installs nothing
 * untriaged". We therefore:
 *   1. require an EXACT, standalone `TRIAGE PASSED` line (not a substring), and
 *   2. treat any `TRIAGE FAILED` line as authoritative — a genuine failure
 *      always prints it, so even an injected PASS line cannot override a real
 *      failure (fail-closed). Neither line present → fail-closed.
 * (The script also sanitizes the echoed target as defense-in-depth, but kit
 * must stay safe against an older, un-updated installed script too.)
 */
export function verdictPassed(output: string): boolean {
  const lines = output.split(/\r?\n/).map((l) => l.trim());
  if (lines.includes("TRIAGE FAILED")) return false;
  return lines.includes("TRIAGE PASSED");
}

/**
 * Mirror env vars (KIT_NPM_REGISTRY, …) derived from `.kit.toml [air_gap]`, so a
 * config-declared internal mirror is honored by the triage subprocess even when
 * the operator didn't export the env var. Best-effort: never breaks triage if
 * the config can't be read. Env vars already in `process.env` still win.
 */
async function airGapMirrorEnv(): Promise<Record<string, string>> {
  try {
    const { loadConfig } = await import("./config.js");
    const { resolveAirGap, airGapTriageEnv } = await import("./airgap/config.js");
    const cfg = await loadConfig(resolve(process.cwd(), ".kit.toml"));
    return airGapTriageEnv(resolveAirGap(cfg.air_gap, process.env));
  } catch {
    return {};
  }
}

/**
 * Run triage on a target
 */
export async function runTriage(type: TriageType, target: string): Promise<TriageResult> {
  const scriptExists = await ensureTriageScript();
  if (!scriptExists) {
    return {
      target,
      type,
      passed: false,
      output: `Triage script not found at ${TRIAGE_SCRIPT}\nInstall: copy triage skill to ~/.claude/skills/triage/`,
    };
  }

  try {
    const { stdout, stderr } = await exec("python3", [TRIAGE_SCRIPT, type, target], {
      timeout: 300_000, // 5 min for Docker pulls
      // config-declared mirrors, with real env taking precedence
      env: { ...(await airGapMirrorEnv()), ...process.env },
    });

    const output = stdout + (stderr ? `\n${stderr}` : "");
    const passed = verdictPassed(output);

    return { target, type, passed, output };
  } catch (error: unknown) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    const output = (err.stdout || "") + (err.stderr || "") + (err.message || "");
    return {
      target,
      type,
      passed: false,
      output: output || "Triage script execution failed",
    };
  }
}

/**
 * List available security tools
 */
export async function listTriageTools(): Promise<TriageResult> {
  return runTriage("tools", "");
}

/**
 * Parse the triage output for structured data
 */
export function parseTriageOutput(output: string): {
  healthScore?: string;
  criticalIssues: number;
  warnings: number;
  sections: string[];
} {
  const healthMatch = output.match(/Health score: (\d+\/\d+)/);
  const criticalMatch = output.match(/Critical issues: (\d+)/);
  const warningsMatch = output.match(/Warnings: (\d+)/);
  const sections = output
    .split("──────")
    .filter((s) => s.trim())
    .map((s) => s.trim().split("\n")[0]?.trim())
    .filter(Boolean);

  return {
    healthScore: healthMatch?.[1],
    criticalIssues: criticalMatch ? parseInt(criticalMatch[1]) : 0,
    warnings: warningsMatch ? parseInt(warningsMatch[1]) : 0,
    sections,
  };
}
