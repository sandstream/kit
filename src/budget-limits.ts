import type { GovernanceAgentConfig } from "./config.js";

/** Token estimates may be fractional, but a limit must be finite and nonnegative. */
export function isTokenLimit(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

/** Operations are discrete and must retain exact integer arithmetic. */
export function isOperationLimit(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function budgetLimitsError(agent: GovernanceAgentConfig): string | undefined {
  if (agent.max_tokens_per_day !== undefined && !isTokenLimit(agent.max_tokens_per_day)) {
    return "Invalid budget limit: max_tokens_per_day must be finite and nonnegative.";
  }
  if (
    agent.max_operations_per_hour !== undefined &&
    !isOperationLimit(agent.max_operations_per_hour)
  ) {
    return "Invalid budget limit: max_operations_per_hour must be a nonnegative safe integer.";
  }
  return undefined;
}
