import { execSync } from "node:child_process";
import type { GovernanceConfig, EnvironmentAccess } from "./config.js";
import { appendAuditEventDirect } from "./audit.js";

export type Environment = "dev" | "staging" | "prod";

export interface EnvironmentInfo {
  environment: Environment;
  source: "env" | "git" | "default";
  access?: EnvironmentAccess;
}

/**
 * Detect current environment based on:
 * 1. NODE_ENV environment variable
 * 2. Git branch name (main→prod, staging→staging, feature/*→dev)
 * 3. Default to 'dev'
 */
export function detectEnvironment(governance?: GovernanceConfig): EnvironmentInfo {
  // 1. Check NODE_ENV
  const nodeEnv = process.env.NODE_ENV?.toLowerCase();
  if (nodeEnv === "production") {
    return {
      environment: "prod",
      source: "env",
      access: governance?.access?.prod,
    };
  }
  if (nodeEnv === "staging") {
    return {
      environment: "staging",
      source: "env",
      access: governance?.access?.staging,
    };
  }
  if (nodeEnv === "development" || nodeEnv === "dev") {
    return {
      environment: "dev",
      source: "env",
      access: governance?.access?.dev,
    };
  }

  // 2. Fall back to git branch
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    if (branch === "main" || branch === "master") {
      return {
        environment: "prod",
        source: "git",
        access: governance?.access?.prod,
      };
    }
    if (branch === "staging") {
      return {
        environment: "staging",
        source: "git",
        access: governance?.access?.staging,
      };
    }
    // Any other branch (feature/*, dev, etc.) → dev
    return {
      environment: "dev",
      source: "git",
      access: governance?.access?.dev,
    };
  } catch {
    // If git is not available or not in a git repo, default to dev
  }

  // 3. Default to dev
  return {
    environment: "dev",
    source: "default",
    access: governance?.access?.dev,
  };
}

/**
 * Check if an operation is allowed in the current environment
 */
export function isOperationAllowed(
  operation: "read" | "write" | "delete",
  envInfo: EnvironmentInfo,
): boolean {
  if (!envInfo.access) {
    // No access config means allow everything (for backwards compatibility)
    return true;
  }

  switch (operation) {
    case "read":
      return envInfo.access.read ?? false;
    case "write":
      return envInfo.access.write ?? false;
    case "delete":
      return envInfo.access.delete ?? false;
    default:
      return false;
  }
}

/**
 * Returns true when running in a non-interactive context.
 * Checks (in order):
 *   1. --non-interactive flag in process.argv
 *   2. KIT_NON_INTERACTIVE=1 (or =true)
 *   3. CI=true (set by GitHub Actions, CircleCI, and most CI systems)
 *
 * When the env-var path (#2) triggers in a context where a TTY is
 * available, emit a one-time stderr warning + audit event. Combined with
 * `KIT_ELEVATED=1`, non-interactive mode lets destructive ops run with
 * zero acknowledgement; surfacing the choice makes the bypass non-silent.
 * CI=true (#3) is not warned about because that's the normal mode there.
 */
let warnedAboutNonInteractive = false;
function warnNonInteractiveOnce(source: "env-var" | "flag"): void {
  if (warnedAboutNonInteractive) return;
  warnedAboutNonInteractive = true;
  console.error(
    `[kit] WARNING: non-interactive mode active (via ${source}) — all confirmation prompts will be skipped.`,
  );
  void appendAuditEventDirect({
    operation: "non-interactive-mode",
    environment: process.env.NODE_ENV ?? "unknown",
    success: true,
    metadata: { source, granter: process.env.USER ?? "unknown" },
  });
}

export function isNonInteractive(): boolean {
  if (process.argv.includes("--non-interactive")) {
    if (process.stdout.isTTY) warnNonInteractiveOnce("flag");
    return true;
  }
  const flag = process.env.KIT_NON_INTERACTIVE?.toLowerCase();
  if (flag === "1" || flag === "true") {
    if (process.stdout.isTTY) warnNonInteractiveOnce("env-var");
    return true;
  }
  if (process.env.CI === "true") return true;
  return false;
}

/**
 * Test-only: reset the module-scoped warning flag.
 */
export function _resetNonInteractiveWarningForTests(): void {
  warnedAboutNonInteractive = false;
}

/**
 * Get a human-readable description of the environment
 */
export function formatEnvironment(envInfo: EnvironmentInfo): string {
  const sourceLabel = {
    env: "NODE_ENV",
    git: "git branch",
    default: "default",
  }[envInfo.source];

  return `${envInfo.environment} (from ${sourceLabel})`;
}
