/**
 * Triage — Security evaluation for open source packages, Docker images, skills, and repos.
 * Wraps the Python triage script and integrates with kit's check-security system.
 */

import { access } from "node:fs/promises";
import { resolve } from "node:path";

import { triageNpmSandbox, type SandboxResult } from "./triage-sandbox.js";
import { exec } from "./utils/exec.js";


const TRIAGE_SCRIPT = resolve(
  process.env.HOME || "~",
  ".claude/skills/triage/scripts/triage.py"
);

export type TriageType = "docker" | "npm" | "pip" | "repo" | "skill" | "all" | "tools";

export { triageNpmSandbox, type SandboxResult };

export interface TriageResult {
  target: string;
  type: TriageType;
  passed: boolean;
  output: string;
}

/**
 * Check if the triage script exists
 */
async function ensureTriageScript(): Promise<boolean> {
  try {
    await access(TRIAGE_SCRIPT);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run triage on a target
 */
export async function runTriage(
  type: TriageType,
  target: string
): Promise<TriageResult> {
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
    const { stdout, stderr } = await exec(
      "python3",
      [TRIAGE_SCRIPT, type, target],
      { timeout: 300_000 } // 5 min for Docker pulls
    );

    const output = stdout + (stderr ? `\n${stderr}` : "");
    const passed = output.includes("TRIAGE PASSED");

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
