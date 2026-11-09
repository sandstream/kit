import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { GovernanceConfig } from "./config.js";
import { mergeGovernanceConfig } from "./governance.js";
import { withBudgetLock } from "./budget-lock.js";
import { budgetLimitsError } from "./budget-limits.js";
import { isReadOnlyMode } from "./read-only-mode.js";
import {
  BUDGET_STATE_ERROR,
  BUDGET_STATE_FILE,
  loadBudgetState,
  saveBudgetState,
  type BudgetState,
} from "./budget-state.js";

function checkedBudgetConfig(config: GovernanceConfig | undefined) {
  const merged = mergeGovernanceConfig(config);
  const error = budgetLimitsError(merged.agent);
  if (error) throw new Error(error);
  return merged;
}

/**
 * Check if operation is within budget limits
 */
export async function checkBudgetLimits(
  config: GovernanceConfig | undefined,
  estimatedTokens = 0,
  opts: { cwd?: string } = {},
): Promise<{ allowed: boolean; reason?: string }> {
  const fullConfig = mergeGovernanceConfig(config);
  const limitError = budgetLimitsError(fullConfig.agent);
  if (limitError) return { allowed: false, reason: limitError };

  if (!fullConfig.enabled) {
    return { allowed: true };
  }
  if (!Number.isFinite(estimatedTokens) || estimatedTokens < 0) {
    return { allowed: false, reason: "Invalid budget token estimate." };
  }

  let state: BudgetState;
  try {
    state = await loadBudgetState(opts.cwd);
  } catch {
    return { allowed: false, reason: BUDGET_STATE_ERROR };
  }

  // Reset counters if needed
  const now = new Date();
  const resetState = resetCountersIfNeeded(state, now);

  return checkStateLimits(resetState, fullConfig.agent, estimatedTokens);
}

function checkStateLimits(
  state: BudgetState,
  agent: ReturnType<typeof mergeGovernanceConfig>["agent"],
  estimatedTokens: number,
): { allowed: boolean; reason?: string } {
  // Check token limit
  const tokenLimit = agent.max_tokens_per_day;
  if (tokenLimit !== undefined && state.tokens_today + estimatedTokens > tokenLimit) {
    return {
      allowed: false,
      reason: `Token budget exceeded: ${state.tokens_today}/${tokenLimit} used today`,
    };
  }

  // Check operation limit
  const operationLimit = agent.max_operations_per_hour;
  if (operationLimit !== undefined && state.operations_this_hour >= operationLimit) {
    return {
      allowed: false,
      reason: `Operation budget exceeded: ${state.operations_this_hour}/${operationLimit} operations this hour`,
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
  opts: { cwd?: string } = {},
): Promise<void> {
  if (!checkedBudgetConfig(config).enabled || isReadOnlyMode()) return;
  if (!Number.isFinite(tokensUsed) || tokensUsed < 0) {
    throw new Error("Invalid budget token usage.");
  }
  const cwd = resolve(opts.cwd ?? process.cwd());
  await withBudgetLock(cwd, async () => {
    const state = resetCountersIfNeeded(await loadBudgetState(cwd), new Date());
    state.tokens_today += tokensUsed;
    state.operations_this_hour += 1;
    await saveBudgetState(state, cwd);
  });
}

interface BudgetCharge {
  generation: string;
  tokens: number;
  tokenReset: string;
  operationReset: string;
}

async function chargeBudget(
  config: GovernanceConfig | undefined,
  tokens: number,
  cwd: string,
): Promise<BudgetCharge> {
  if (!Number.isFinite(tokens) || tokens < 0) throw new Error("Invalid budget token estimate.");
  return withBudgetLock(cwd, async () => {
    const state = resetCountersIfNeeded(await loadBudgetState(cwd), new Date());
    const check = checkStateLimits(state, checkedBudgetConfig(config).agent, tokens);
    if (!check.allowed) throw new Error(check.reason);
    state.generation ??= randomUUID();
    state.tokens_today += tokens;
    state.operations_this_hour += 1;
    await saveBudgetState(state, cwd);
    return {
      generation: state.generation,
      tokens,
      tokenReset: state.last_token_reset,
      operationReset: state.last_operation_reset,
    };
  });
}

async function refundBudget(charge: BudgetCharge, cwd: string): Promise<void> {
  await withBudgetLock(cwd, async () => {
    const state = resetCountersIfNeeded(await loadBudgetState(cwd), new Date());
    // An explicit reset creates a new ledger. Never refund someone else's allowance.
    if (state.generation !== charge.generation) return;
    if (state.last_token_reset === charge.tokenReset) {
      const remaining = state.tokens_today - charge.tokens;
      // Fractional estimates can leave a rounding residue on either side of zero.
      const roundoff =
        Number.EPSILON * Math.min(1, 2 * Math.max(state.tokens_today, charge.tokens));
      state.tokens_today = remaining <= roundoff ? 0 : remaining;
    }
    if (state.last_operation_reset === charge.operationReset) state.operations_this_hour -= 1;
    await saveBudgetState(state, cwd);
  });
}

export class BudgetRefundError extends Error {
  constructor(
    readonly operationError: unknown,
    refundError: unknown,
  ) {
    super("Operation failed; could not refund reserved budget.", {
      cause: new AggregateError([operationError, refundError]),
    });
  }
}

/** Book allowance before execution. Refund only a thrown operation; a crash stays charged. */
export async function withBudget<T>(
  config: GovernanceConfig | undefined,
  estimatedTokens: number,
  operation: () => Promise<T>,
  opts: { cwd?: string } = {},
): Promise<T> {
  if (!checkedBudgetConfig(config).enabled) return operation();
  const cwd = resolve(opts.cwd ?? process.cwd());
  if (isReadOnlyMode()) {
    const check = await checkBudgetLimits(config, estimatedTokens, { cwd });
    if (!check.allowed) throw new Error(check.reason);
    return operation();
  }
  const charge = await chargeBudget(config, estimatedTokens, cwd);
  try {
    return await operation();
  } catch (error) {
    try {
      await refundBudget(charge, cwd);
    } catch (refundError) {
      throw new BudgetRefundError(error, refundError);
    }
    throw error;
  }
}

/**
 * Reset counters if time periods have elapsed
 */
function resetCountersIfNeeded(state: BudgetState, now: Date): BudgetState {
  const newState = { ...state };

  // Reset token counter at midnight
  const lastTokenReset = new Date(state.last_token_reset);
  const isNewDay =
    now.getFullYear() !== lastTokenReset.getFullYear() ||
    now.getMonth() !== lastTokenReset.getMonth() ||
    now.getDate() !== lastTokenReset.getDate();

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
export async function getBudgetStatus(
  config: GovernanceConfig | undefined,
  opts: { cwd?: string } = {},
): Promise<{
  tokens_used: number;
  tokens_limit: number | undefined;
  operations_used: number;
  operations_limit: number | undefined;
}> {
  const fullConfig = checkedBudgetConfig(config);
  const state = await loadBudgetState(opts.cwd);
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

  if (status.tokens_limit !== undefined) {
    const tokenPercent =
      status.tokens_limit === 0
        ? "limit is zero"
        : `${((status.tokens_used / status.tokens_limit) * 100).toFixed(1)}%`;
    lines.push(
      `Tokens: ${status.tokens_used.toLocaleString()}/${status.tokens_limit.toLocaleString()} (${tokenPercent})`,
    );
  } else {
    lines.push(`Tokens: ${status.tokens_used.toLocaleString()} (no limit)`);
  }

  if (status.operations_limit !== undefined) {
    const opPercent =
      status.operations_limit === 0
        ? "limit is zero"
        : `${((status.operations_used / status.operations_limit) * 100).toFixed(1)}%`;
    lines.push(`Operations: ${status.operations_used}/${status.operations_limit} (${opPercent})`);
  } else {
    lines.push(`Operations: ${status.operations_used} (no limit)`);
  }

  return lines.join("\n");
}

/**
 * Clear budget state (for testing/development)
 */
export async function clearBudgetState(opts: { cwd?: string } = {}): Promise<void> {
  if (isReadOnlyMode()) return;
  const cwd = resolve(opts.cwd ?? process.cwd());
  await withBudgetLock(cwd, async () => {
    try {
      const { unlink } = await import("node:fs/promises");
      await unlink(resolve(cwd, BUDGET_STATE_FILE));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error("Could not clear budget usage. Check .kit-budget.json.", { cause: error });
      }
    }
  });
}
