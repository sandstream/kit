import { c } from "../utils/colors.js";
import { loadConfig, resolveActiveEnvironment, type GovernanceConfig } from "../config.js";
import { resolveConfigPath } from "../cli-shared.js";
import {
  mergeGovernanceConfig,
  getCurrentEnvironmentInfo,
  formatGovernanceStatus,
} from "../governance.js";
import { getBudgetStatus, formatBudgetStatus } from "../budget.js";
import { sanitizeDisplayText } from "../display-text.js";
import { isReadOnlyMode } from "../read-only-mode.js";

import { readRevocationStatus } from "../revocation-transport.js";

interface RevocationReport {
  status: "disabled" | "active" | "revoked" | "unverified" | "not checked (governance disabled)";
  error?: string;
}

/** Read a fresh verdict without turning a transport failure into confirmed revocation. */
async function inspectRevocation(config: Required<GovernanceConfig>): Promise<RevocationReport> {
  if (!config.enabled) return { status: "not checked (governance disabled)" };
  if (!config.revocation.enabled) return { status: "disabled" };
  const observation = await readRevocationStatus({
    endpoint: config.revocation.revocation_endpoint,
    agentId: config.agent.id,
  });
  return observation.verified
    ? { status: observation.status.revoked ? "revoked" : "active" }
    : { status: "unverified", error: observation.error };
}

export async function cmdGovernance(): Promise<boolean> {
  let config;
  try {
    config = await loadConfig(resolveConfigPath());
  } catch {
    console.error("Could not read or validate project configuration. Check .kit.toml.");
    return false;
  }
  let budget;
  try {
    budget = await getBudgetStatus(config.governance);
  } catch {
    console.error("Could not read budget usage. Check .kit-budget.json.");
    return false;
  }
  const environment = await getCurrentEnvironmentInfo(config.governance);
  const governanceConfig = {
    ...mergeGovernanceConfig(config.governance),
    environment: environment.environment,
  };
  const revocation = await inspectRevocation(governanceConfig);

  console.log(`${c.bold}${c.cyan}Governance Status${c.reset}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);

  // Display governance configuration
  console.log(formatGovernanceStatus(governanceConfig));
  console.log(`Config env: ${sanitizeDisplayText(resolveActiveEnvironment())}`);
  console.log(`Access env: ${environment.environment} (via ${environment.source})`);
  console.log(
    `Read-only mode: ${isReadOnlyMode() ? "active (write and delete operations refused)" : "inactive"}`,
  );
  console.log();

  console.log(`Revocation status: ${revocation.status}`);
  if (revocation.error) console.error(revocation.error);

  // Display budget status
  console.log();
  console.log(`Budget enforcement: ${governanceConfig.enabled ? "enabled" : "disabled"}`);
  console.log(formatBudgetStatus(budget));

  // Display agent info
  if (governanceConfig.agent.id || governanceConfig.agent.name) {
    console.log();
    console.log("Agent Information");
    console.log("─".repeat(50));
    if (governanceConfig.agent.name) {
      console.log(`Name: ${sanitizeDisplayText(governanceConfig.agent.name)}`);
    }
    if (governanceConfig.agent.id) {
      console.log(`ID: ${sanitizeDisplayText(governanceConfig.agent.id)}`);
    }
  } else {
    console.log("No agent configured in [governance.agent].");
  }

  console.log();
  return revocation.status !== "revoked" && revocation.status !== "unverified";
}
