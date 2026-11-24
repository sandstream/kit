import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { AuditOutcome, AuditRunner } from "./advisory-baseline.js";
import { readBunAuditEvidence } from "./bun-audit-evidence.js";
import { managerAuditEnv, type Manager } from "./manager-audit-config.js";
import {
  managerScopeChanged,
  readManagerAuditScope,
  type ManagerAuditScope,
} from "./manager-audit-scope.js";
import { readPnpmAuditEvidence } from "./pnpm-audit-evidence.js";
import { readYarnAuditEvidence } from "./yarn-audit-evidence.js";

function yarnArgs(): string[] {
  return [
    "npm",
    "audit",
    "--all",
    "--recursive",
    "--environment",
    "all",
    "--severity",
    "info",
    "--no-deprecations",
  ];
}

export function managerAuditRunner(manager: Manager): AuditRunner {
  if (manager === "yarn")
    return {
      manager,
      command: ["yarn", ...yarnArgs(), "--json"],
      proofCommand: ["yarn", ...yarnArgs()],
      versionCommand: ["yarn", "--version"],
    };
  if (manager === "pnpm")
    return {
      manager,
      command: ["pnpm", "audit", "--json", "--audit-level=info", "--ignore-registry-errors=false"],
    };
  return { manager, command: ["bun", "audit", "--json"] };
}

function execute(command: string[], cwd: string, env: NodeJS.ProcessEnv, timeout: number) {
  const [bin, ...args] = command;
  const result = spawnSync(bin, args, {
    cwd,
    env,
    timeout,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status,
    error: result.error ? "audit subprocess failed to complete" : undefined,
  };
}

function readEvidence(
  scope: ManagerAuditScope,
  output: ReturnType<typeof execute>,
): Omit<AuditOutcome, "manager"> {
  if (scope.manager === "pnpm") return readPnpmAuditEvidence(output);
  if (scope.manager === "yarn") return readYarnAuditEvidence(output);
  return readBunAuditEvidence(output, scope.bunPackages);
}

/** Bun audit can load the target's .env even when passed --no-env-file. */
function executeBun(lock: Buffer, command: string[], env: NodeJS.ProcessEnv, timeout: number) {
  const dir = mkdtempSync(join(tmpdir(), "kit-bun-audit-"));
  try {
    writeFileSync(join(dir, "bun.lock"), lock, { flag: "wx", mode: 0o600 });
    writeFileSync(join(dir, "package.json"), '{"name":"kit-audit-target","private":true}\n', {
      flag: "wx",
      mode: 0o600,
    });
    return execute(
      command,
      dir,
      { ...env, HOME: dir, USERPROFILE: dir, XDG_CONFIG_HOME: dir },
      timeout,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}

function acquire(
  scope: ManagerAuditScope,
  command: string[],
  root: string,
  env: NodeJS.ProcessEnv,
  timeout: number,
) {
  try {
    return scope.bunLock
      ? executeBun(scope.bunLock, command, env, timeout)
      : execute(command, root, env, timeout);
  } catch {
    return { stdout: "", stderr: "", exitCode: null, error: "audit could not acquire evidence" };
  }
}

function confirmYarnEmpty(
  root: string,
  runner: AuditRunner,
  env: NodeJS.ProcessEnv,
  budget: number,
): boolean {
  if (!runner.proofCommand || budget <= 0) return false;
  const result = execute(runner.proofCommand, root, env, budget);
  return (
    !result.error &&
    result.exitCode === 0 &&
    result.stderr.trim() === "" &&
    /^➤ YN0001: No audit suggestions\r?\n?$/.test(stripVTControlCharacters(result.stdout))
  );
}

function supportedYarn(
  root: string,
  runner: AuditRunner,
  env: NodeJS.ProcessEnv,
  timeout: number,
): boolean {
  if (!runner.versionCommand || timeout <= 0) return false;
  const result = execute(runner.versionCommand, root, env, timeout);
  return (
    !result.error &&
    result.exitCode === 0 &&
    result.stderr.trim() === "" &&
    /^4\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(result.stdout.trim())
  );
}

export function runManagerAudit(
  root: string,
  runner: AuditRunner,
  manager: Manager,
  timeout: number,
  env: NodeJS.ProcessEnv,
): AuditOutcome {
  const scope = readManagerAuditScope(root, manager, env);
  if ("status" in scope)
    return { manager, advisories: [], error: scope.reason, evidenceStatus: scope.status };
  const safeEnv = managerAuditEnv(env);
  const started = Date.now();
  if (manager === "yarn" && !supportedYarn(root, runner, safeEnv, Math.min(timeout, 10_000))) {
    return {
      manager,
      advisories: [],
      error: "Yarn 4 audit executable could not be verified",
      evidenceStatus: "unsupported",
    };
  }
  const remaining = Math.max(1, timeout - (Date.now() - started));
  let outcome = readEvidence(scope, acquire(scope, runner.command, root, safeEnv, remaining));
  if (!outcome.error && scope.gap)
    outcome = { ...outcome, error: scope.gap.reason, evidenceStatus: scope.gap.status };
  if (
    manager === "yarn" &&
    outcome.evidenceStatus === "complete-empty" &&
    !confirmYarnEmpty(root, runner, safeEnv, timeout - (Date.now() - started))
  ) {
    outcome = {
      ...outcome,
      error: "Yarn did not confirm its empty JSON result",
      evidenceStatus: "missing",
    };
  }
  if (managerScopeChanged(scope))
    return {
      ...outcome,
      manager,
      error: "audit inputs changed during the scan",
      evidenceStatus: "stale",
    };
  return { ...outcome, manager };
}
