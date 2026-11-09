import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig, type kitConfig } from "./config.js";
import { extractHostsFromArgs } from "./broker/extract.js";
import { isReadOnlyMode, refuseWrite } from "./read-only-mode.js";
import { runBrokered, type BrokerContext } from "./exec-broker/broker.js";
import {
  runGovernedBrokered,
  withGovernance,
  type GovernedOutcome,
} from "./governance-middleware.js";
import {
  executeCommand,
  redactArgumentsForEnvironment,
  type RunOptions,
  type RunResult,
} from "./run.js";

/** A missing config is optional. An existing but invalid config must never disable policy. */
async function loadRunConfig(cwd: string): Promise<kitConfig> {
  const path = resolve(cwd, ".kit.toml");
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  return loadConfig(path);
}

function assessRunResult(result: RunResult): { success: boolean; error?: string } {
  if (result.timedOut) return { success: false, error: "Command timed out" };
  if (result.truncated) return { success: false, error: "Command output exceeded the limit" };
  return result.exitCode === 0
    ? { success: true }
    : { success: false, error: `Command exited with code ${result.exitCode}` };
}

/** Apply the same project policy and outcome audit to CLI and MCP child commands. */
export async function executeGovernedCommand(
  opts: RunOptions & { interactiveApproval?: boolean },
): Promise<GovernedOutcome<RunResult>> {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const config = await loadRunConfig(cwd);
  if (isReadOnlyMode() || config.policy?.default_mode === "read-only") {
    return refuseWrite("run", {}, { cwd });
  }
  const displayArgs = await redactArgumentsForEnvironment(opts.commandArgs, cwd, opts);
  const context: BrokerContext = {
    operation: "run",
    operationType: "write",
    metadata: {
      command: displayArgs.map((arg) => JSON.stringify(arg)).join(" "),
      mediation: "egress-only (arbitrary command; fs/env un-mediated)",
    },
    // Explicit URLs and curl/wget host arguments are visible. Other effects remain unmediated.
    egressTargets: extractHostsFromArgs(opts.commandArgs),
  };
  const operation = () => executeCommand({ ...opts, cwd });
  const governanceOptions = { cwd, assessResult: assessRunResult };
  if (!opts.interactiveApproval) {
    return runGovernedBrokered(config, context, operation, governanceOptions);
  }

  let failedResult: RunResult | undefined;
  const outcome = await runBrokered(
    context,
    async () => {
      const result = await withGovernance(config, context, operation, governanceOptions);
      const assessment = assessRunResult(result);
      if (!assessment.success) {
        failedResult = result;
        throw new Error(assessment.error);
      }
      return result;
    },
    { cwd },
  );
  if (!outcome.ok && failedResult) {
    return { ok: false, result: failedResult, reason: outcome.reason };
  }
  return outcome.ok ? { ok: true, result: outcome.result } : { ok: false, reason: outcome.reason };
}
