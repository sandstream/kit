import { lstat } from "node:fs/promises";
import { getBudgetStatus, formatBudgetStatus } from "../budget.js";
import { resolveConfigPath } from "../cli-shared.js";
import { loadConfig, resolveActiveEnvironment, type kitConfig } from "../config.js";
import { sanitizeDisplayText } from "../display-text.js";
import { getCurrentEnvironmentInfo, type GovernanceEnvironmentInfo } from "../governance.js";
import { c } from "../utils/colors.js";
import { hasFlag } from "../utils/flags.js";

interface WhoamiReport {
  agent: { id?: string; name?: string } | null;
  environment: GovernanceEnvironmentInfo["environment"];
  environment_source: GovernanceEnvironmentInfo["source"];
  config_environment: string;
  budget: Awaited<ReturnType<typeof getBudgetStatus>> | null;
}

async function readWhoamiConfig(): Promise<Pick<kitConfig, "governance">> {
  const path = resolveConfigPath();
  const message = "Could not read or validate project configuration. Check .kit.toml.";
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(message, { cause: error });
  }
  try {
    return await loadConfig(path);
  } catch {
    throw new Error(message);
  }
}

async function whoamiReport(): Promise<WhoamiReport> {
  const config = await readWhoamiConfig();
  const environment = await getCurrentEnvironmentInfo(config.governance);
  const agent = config.governance?.agent;
  const id = agent?.id === undefined ? undefined : sanitizeDisplayText(agent.id);
  const name = agent?.name === undefined ? undefined : sanitizeDisplayText(agent.name);
  let budget: WhoamiReport["budget"] = null;
  if (config.governance?.enabled) {
    try {
      budget = await getBudgetStatus(config.governance);
    } catch {
      throw new Error("Could not read budget usage. Check .kit-budget.json.");
    }
  }
  return {
    agent: id || name ? { id, name } : null,
    environment: environment.environment,
    environment_source: environment.source,
    config_environment: sanitizeDisplayText(resolveActiveEnvironment()),
    budget,
  };
}

function printWhoami(report: WhoamiReport): void {
  console.log(`${c.bold}${c.cyan}kit whoami${c.reset}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);
  if (report.agent) {
    if (report.agent.name) console.log(`  ${c.bold}Agent:${c.reset} ${report.agent.name}`);
    if (report.agent.id)
      console.log(`  ${c.bold}ID:${c.reset} ${c.dim}${report.agent.id}${c.reset}`);
  } else {
    console.log(`  ${c.dim}No agent configured in [governance.agent]${c.reset}`);
  }
  const color =
    report.environment === "prod" ? c.red : report.environment === "staging" ? c.yellow : c.green;
  console.log(`  ${c.bold}Config env:${c.reset} ${report.config_environment}`);
  console.log(
    `  ${c.bold}Access env:${c.reset} ${color}${report.environment}${c.reset} ${c.dim}(via ${report.environment_source})${c.reset}`,
  );
  if (report.budget) console.log(`\n${formatBudgetStatus(report.budget)}`);
  console.log();
}

/** Report configured identity and the same access environment used by governance. */
export async function cmdWhoami(): Promise<boolean> {
  const jsonMode = hasFlag(process.argv, "--json");
  try {
    const report = await whoamiReport();
    if (jsonMode) console.log(JSON.stringify(report, null, 2));
    else printWhoami(report);
    return true;
  } catch (error) {
    const message = sanitizeDisplayText(error instanceof Error ? error.message : String(error));
    if (jsonMode) console.log(JSON.stringify({ ok: false, error: message }));
    console.error(message);
    return false;
  }
}
