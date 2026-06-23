import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { GovernanceConfig } from "./config.js";
import { mergeGovernanceConfig } from "./governance.js";

const BUDGET_STATE_FILE = ".kit-budget.json";

interface BudgetState {
  tokens_today: number;
  operations_this_hour: number;
  last_token_reset: string;
  last_operation_reset: string;
}

/**
 * Check if operation is within budget limits
 */
export async function checkBudgetLimits(
  config: GovernanceConfig | undefined,
  estimatedTokens = 0,
): Promise<{ allowed: boolean; reason?: string }> {
  const fullConfig = mergeGovernanceConfig(config);

  if (!fullConfig.enabled) {
    return { allowed: true };
  }

  const state = await loadBudgetState();

  // Reset counters if needed
  const now = new Date();
  const resetState = resetCountersIfNeeded(state, now);

  // Check token limit
  const tokenLimit = fullConfig.agent.max_tokens_per_day;
  if (tokenLimit && resetState.tokens_today + estimatedTokens > tokenLimit) {
    return {
      allowed: false,
      reason: `Token budget exceeded: ${resetState.tokens_today}/${tokenLimit} used today`,
    };
  }

  // Check operation limit
  const operationLimit = fullConfig.agent.max_operations_per_hour;
  if (operationLimit && resetState.operations_this_hour >= operationLimit) {
    return {
      allowed: false,
      reason: `Operation budget exceeded: ${resetState.operations_this_hour}/${operationLimit} operations this hour`,
    };
  }

  return { allowed: true };
}

/**
 * Record token and operation usage
 */
export async function recordUsage(
  config: GovernanceConfig | undefined,
  tokensUsed: number,
): Promise<void> {
  const fullConfig = mergeGovernanceConfig(config);

  if (!fullConfig.enabled) {
    return;
  }

  const state = await loadBudgetState();
  const now = new Date();
  const resetState = resetCountersIfNeeded(state, now);

  // Update usage
  resetState.tokens_today += tokensUsed;
  resetState.operations_this_hour += 1;

  await saveBudgetState(resetState);
}

/**
 * Load budget state from file
 */
async function loadBudgetState(): Promise<BudgetState> {
  const statePath = resolve(process.cwd(), BUDGET_STATE_FILE);

  try {
    const content = await readFile(statePath, "utf-8");
    return JSON.parse(content) as BudgetState;
  } catch {
    // No state file exists, return fresh state
    const now = new Date().toISOString();
    return {
      tokens_today: 0,
      operations_this_hour: 0,
      last_token_reset: now,
      last_operation_reset: now,
    };
  }
}

/**
 * Save budget state to file
 */
async function saveBudgetState(state: BudgetState): Promise<void> {
  const statePath = resolve(process.cwd(), BUDGET_STATE_FILE);

  try {
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify(state, null, 2), "utf-8");
  } catch (error) {
    console.error("Failed to save budget state:", error);
  }
}

/**
 * Reset counters if time periods have elapsed
 */
function resetCountersIfNeeded(state: BudgetState, now: Date): BudgetState {
  const newState = { ...state };

  // Reset token counter at midnight
  const lastTokenReset = new Date(state.last_token_reset);
  const isNewDay = now.getDate() !== lastTokenReset.getDate();

  if (isNewDay) {
    newState.tokens_today = 0;
    newState.last_token_reset = now.toISOString();
  }

  // Reset operation counter every hour
  const lastOperationReset = new Date(state.last_operation_reset);
  const elapsedHours = (now.getTime() - lastOperationReset.getTime()) / (1000 * 60 * 60);

  if (elapsedHours >= 1) {
    newState.operations_this_hour = 0;
    newState.last_operation_reset = now.toISOString();
  }

  return newState;
}

/**
 * Get current budget status for display
 */
export async function getBudgetStatus(config: GovernanceConfig | undefined): Promise<{
  tokens_used: number;
  tokens_limit: number | undefined;
  operations_used: number;
  operations_limit: number | undefined;
}> {
  const fullConfig = mergeGovernanceConfig(config);
  const state = await loadBudgetState();
  const now = new Date();
  const resetState = resetCountersIfNeeded(state, now);

  return {
    tokens_used: resetState.tokens_today,
    tokens_limit: fullConfig.agent.max_tokens_per_day,
    operations_used: resetState.operations_this_hour,
    operations_limit: fullConfig.agent.max_operations_per_hour,
  };
}

/**
 * Format budget status for display
 */
export function formatBudgetStatus(status: {
  tokens_used: number;
  tokens_limit: number | undefined;
  operations_used: number;
  operations_limit: number | undefined;
}): string {
  const lines: string[] = [];

  lines.push("Budget Status");
  lines.push("─".repeat(50));

  if (status.tokens_limit) {
    const tokenPercent = ((status.tokens_used / status.tokens_limit) * 100).toFixed(1);
    lines.push(
      `Tokens: ${status.tokens_used.toLocaleString()}/${status.tokens_limit.toLocaleString()} (${tokenPercent}%)`,
    );
  } else {
    lines.push(`Tokens: ${status.tokens_used.toLocaleString()} (no limit)`);
  }

  if (status.operations_limit) {
    const opPercent = ((status.operations_used / status.operations_limit) * 100).toFixed(1);
    lines.push(`Operations: ${status.operations_used}/${status.operations_limit} (${opPercent}%)`);
  } else {
    lines.push(`Operations: ${status.operations_used} (no limit)`);
  }

  return lines.join("\n");
}

/**
 * Clear budget state (for testing/development)
 */
export async function clearBudgetState(): Promise<void> {
  const statePath = resolve(process.cwd(), BUDGET_STATE_FILE);

  try {
    const { unlink } = await import("node:fs/promises");
    await unlink(statePath);
  } catch {
    // Ignore if file doesn't exist
  }
}
