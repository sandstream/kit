import type { kitConfig } from "./config.js";
import {
  mergeGovernanceConfigAsync,
  checkOperationAllowed,
  type OperationType,
} from "./governance.js";
import { checkRevocationStatus, handleRevocation } from "./revocation.js";
import { checkBudgetLimits, recordUsage } from "./budget.js";
import { logAuditEvent } from "./audit.js";
import { requestApproval } from "./approval.js";
import {
  checkSecretExpiration,
  formatSecretExpirationWarnings,
  hasExpiredSecrets,
} from "./secret-expiration.js";
import { checkScopeNeeds, type ScopeNeeds } from "./exec-broker/scope-needs.js";

export interface OperationContext {
  operation: string;
  operationType: OperationType;
  destructive?: boolean;
  metadata?: Record<string, unknown>;
  estimatedTokens?: number;
  /**
   * What this operation is about to touch (hosts / write paths / secret env keys) — the
   * exec-broker's input (Pillar 3). Optional and additive: undeclared ⇒ no scope check (the
   * advisory floor is unchanged). When declared AND the project declares a [scope]/RoE, every
   * need must be inside the VERIFIED scope — see exec-broker/scope-needs.ts for the rules.
   */
  scopeNeeds?: ScopeNeeds;
}

export interface GovernanceResult {
  allowed: boolean;
  reason?: string;
  warnings?: string[];
}

/**
 * Execute an operation with full governance checks
 */
export async function withGovernance<T>(
  config: kitConfig,
  context: OperationContext,
  operation: () => Promise<T>,
): Promise<T> {
  const startTime = Date.now();
  const governanceConfig = await mergeGovernanceConfigAsync(config.governance);

  // Skip governance if disabled
  if (!governanceConfig.enabled) {
    return await operation();
  }

  // Audit a denied operation with the shared event shape. DRYs the 5 pre-execute
  // deny paths below — each fails closed (audit, then throw).
  const auditDeny = (error: string, extra?: Record<string, unknown>) =>
    logAuditEvent(governanceConfig, {
      operation: context.operation,
      environment: governanceConfig.environment,
      success: false,
      error,
      metadata: extra ? { ...context.metadata, ...extra } : context.metadata,
    });

  // 1. Check revocation status
  const revoked = await checkRevocationStatus(config.governance);
  if (revoked) {
    await handleRevocation(config.governance);
    await auditDeny("Access revoked");
    throw new Error("Access revoked");
  }

  // 2. Check budget limits
  const budgetCheck = await checkBudgetLimits(config.governance, context.estimatedTokens || 0);
  if (!budgetCheck.allowed) {
    await auditDeny(budgetCheck.reason || "Budget limit exceeded");
    throw new Error(budgetCheck.reason || "Budget limit exceeded");
  }

  // 2.5 Scope enforcement (exec-broker, Pillar 3): declared needs vs the signed [scope]/RoE.
  //     Checked BEFORE any approval prompt — a scope denial is not operator-overridable (the
  //     RoE is a signed artifact; widening it means editing + re-signing the profile), so the
  //     operator is never prompted to approve an operation that will be scope-denied anyway.
  if (context.scopeNeeds) {
    const scopeDenial = await checkScopeNeeds(context.scopeNeeds);
    if (scopeDenial) {
      await auditDeny(scopeDenial);
      throw new Error(scopeDenial);
    }
  }

  // Track whether the operator already approved this op in step 3, so a
  // destructive op that also needed permission-approval isn't prompted twice.
  let approvedForOp = false;

  // 3. Check operation permissions
  const permissionCheck = checkOperationAllowed(governanceConfig, context.operationType);
  if (!permissionCheck.allowed) {
    // Check if approval can override
    if (permissionCheck.requiresApproval) {
      const approved = await requestApproval(config.governance, {
        operation: context.operation,
        environment: governanceConfig.environment,
        reason: permissionCheck.reason || "Operation requires approval",
        metadata: context.metadata,
      });

      if (!approved) {
        await auditDeny("Approval denied");
        throw new Error("Operation not approved");
      }
      approvedForOp = true;
    } else {
      await auditDeny(permissionCheck.reason || "Operation not allowed");
      throw new Error(permissionCheck.reason || "Operation not allowed");
    }
  }

  // 4. Destructive operations require approval — unless step 3 already obtained
  //    approval for this same operation (avoid prompting the operator twice).
  if (context.destructive && !approvedForOp) {
    const approved = await requestApproval(config.governance, {
      operation: context.operation,
      environment: governanceConfig.environment,
      reason: "Destructive operation requires approval",
      metadata: context.metadata,
    });

    if (!approved) {
      await auditDeny("Destructive operation denied");
      throw new Error("Destructive operation not approved");
    }
  }

  // 5. Check secret expiration — BLOCKS the operation if any secret is expired
  if (governanceConfig.secrets.check_expiration && config.secrets?.keys) {
    const secretKeys = Object.keys(config.secrets.keys);
    const expirations = await checkSecretExpiration(config.governance, secretKeys, config.secrets);

    if (hasExpiredSecrets(expirations)) {
      const warnings = formatSecretExpirationWarnings(expirations);
      console.warn("\n" + warnings);

      // Block operation if secrets are expired
      await auditDeny("Expired secrets detected", {
        expired_secrets: expirations.filter((e) => e.expired).map((e) => e.key),
      });
      throw new Error("Operation blocked: expired secrets detected");
    }
  }

  // Fail-closed auditability for DESTRUCTIVE ops: persist an authorization entry
  // BEFORE executing and refuse if it can't be written. The post-execution
  // success log alone is fail-open (the op would run unlogged if the audit
  // append failed) — this closes that gap for the operations that matter most.
  if (context.destructive) {
    const logged = await logAuditEvent(governanceConfig, {
      operation: context.operation,
      environment: governanceConfig.environment,
      success: true,
      metadata: { ...context.metadata, phase: "authorized" },
    });
    if (!logged) {
      throw new Error("audit-log unavailable; refusing destructive operation (fail-closed)");
    }
  }

  // Execute the operation
  let error: string | undefined;
  let result: T;

  try {
    result = await operation();
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);

    // Log failure
    await logAuditEvent(governanceConfig, {
      operation: context.operation,
      environment: governanceConfig.environment,
      success: false,
      duration_ms: Date.now() - startTime,
      error,
      metadata: context.metadata,
    });

    throw err;
  }

  // 6. Record usage and log success
  await recordUsage(config.governance, context.estimatedTokens || 0);

  await logAuditEvent(governanceConfig, {
    operation: context.operation,
    environment: governanceConfig.environment,
    success: true,
    duration_ms: Date.now() - startTime,
    metadata: context.metadata,
  });

  return result;
}

export interface GovernedOutcome<T> {
  /** True → the op ran; result is set. False → denied or the op threw; reason is set. */
  ok: boolean;
  result?: T;
  reason?: string;
}

/**
 * MCP-safe governed execution — the shared "floor" the MCP mutating tools were
 * bypassing (they only checked `isReadOnlyMode`). Unlike {@link withGovernance},
 * which can PROMPT for approval on stdin and print to stdout — both fatal on the
 * MCP stdio channel, where stdout IS the JSON-RPC transport — this NEVER prompts
 * and writes NOTHING to stdout. It runs the deterministic pre-flight checks
 * (revocation → budget → permission → secret-expiration), FAIL-CLOSED-denies
 * anything that would require interactive approval (a destructive op, or a
 * permission that only `requiresApproval` can override — approval can't be
 * requested over the protocol channel), emits the same audit events, then executes
 * and audits success/failure. Returns an outcome the caller renders itself.
 */
export async function runGoverned<T>(
  config: kitConfig,
  context: OperationContext,
  operation: () => Promise<T>,
): Promise<GovernedOutcome<T>> {
  const startTime = Date.now();
  const governanceConfig = await mergeGovernanceConfigAsync(config.governance);

  // Governance disabled → run, no audit (nothing is being governed).
  if (!governanceConfig.enabled) {
    try {
      return { ok: true, result: await operation() };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  const auditDeny = (error: string, extra?: Record<string, unknown>) =>
    logAuditEvent(governanceConfig, {
      operation: context.operation,
      environment: governanceConfig.environment,
      success: false,
      error,
      metadata: extra ? { ...context.metadata, ...extra } : context.metadata,
    });

  // 1. Revocation
  if (await checkRevocationStatus(config.governance)) {
    await auditDeny("Access revoked");
    return { ok: false, reason: "Access revoked" };
  }

  // 2. Budget
  const budgetCheck = await checkBudgetLimits(config.governance, context.estimatedTokens || 0);
  if (!budgetCheck.allowed) {
    const reason = budgetCheck.reason || "Budget limit exceeded";
    await auditDeny(reason);
    return { ok: false, reason };
  }

  // 3. Permission — fail CLOSED for anything approval-gated (can't prompt over MCP).
  const permissionCheck = checkOperationAllowed(governanceConfig, context.operationType);
  if (!permissionCheck.allowed) {
    const reason = permissionCheck.requiresApproval
      ? `${permissionCheck.reason || "Operation requires approval"} — approval cannot be requested over the MCP channel; run this via the kit CLI to approve`
      : permissionCheck.reason || "Operation not allowed";
    await auditDeny(reason);
    return { ok: false, reason };
  }

  // 4. Destructive ops need approval → not available non-interactively over MCP.
  if (context.destructive) {
    const reason =
      "Destructive operation requires interactive approval — run it via the kit CLI, not MCP";
    await auditDeny(reason);
    return { ok: false, reason };
  }

  // 5. Secret expiration blocks the op.
  if (governanceConfig.secrets.check_expiration && config.secrets?.keys) {
    const secretKeys = Object.keys(config.secrets.keys);
    const expirations = await checkSecretExpiration(config.governance, secretKeys, config.secrets);
    if (hasExpiredSecrets(expirations)) {
      await auditDeny("Expired secrets detected", {
        expired_secrets: expirations.filter((e) => e.expired).map((e) => e.key),
      });
      return { ok: false, reason: "Operation blocked: expired secrets detected" };
    }
  }

  // Execute + audit success/failure.
  try {
    const result = await operation();
    await recordUsage(config.governance, context.estimatedTokens || 0);
    await logAuditEvent(governanceConfig, {
      operation: context.operation,
      environment: governanceConfig.environment,
      success: true,
      duration_ms: Date.now() - startTime,
      metadata: context.metadata,
    });
    return { ok: true, result };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await logAuditEvent(governanceConfig, {
      operation: context.operation,
      environment: governanceConfig.environment,
      success: false,
      duration_ms: Date.now() - startTime,
      error,
      metadata: context.metadata,
    });
    return { ok: false, reason: error };
  }
}

/**
 * {@link runGoverned} with the Pelare 3 exec-broker composed ON TOP. The broker
 * gates an operation's declared RESOURCE effects (egress / fs-write / env)
 * BEFORE governance (identity / budget / permission) runs; the two are separate
 * concerns that stack.
 *
 * OPT-IN and non-breaking: `runBrokered` is a passthrough unless a broker policy
 * file (`.kit-exec-broker.json` / `KIT_EXEC_BROKER_POLICY`) is present, so a call
 * site swapping `runGoverned` → `runGovernedBrokered` behaves IDENTICALLY until a
 * user opts in by dropping a policy in. A present-but-malformed policy fails
 * closed (deny). Returns the same {@link GovernedOutcome} shape callers already
 * render.
 */
export async function runGovernedBrokered<T>(
  config: kitConfig,
  context: OperationContext,
  operation: () => Promise<T>,
): Promise<GovernedOutcome<T>> {
  const { runBrokered } = await import("./exec-broker/index.js");
  const outcome = await runBrokered(context, async () => {
    const gov = await runGoverned(config, context, operation);
    // Signal a governance denial (or op error) as a throw so the broker layer
    // surfaces it as a not-ok outcome with the same reason.
    if (!gov.ok) throw new Error(gov.reason ?? "denied");
    return gov.result as T;
  });
  return outcome.ok ? { ok: true, result: outcome.result } : { ok: false, reason: outcome.reason };
}

/**
 * Perform pre-flight checks without executing the operation
 */
export async function checkGovernance(
  config: kitConfig,
  context: OperationContext,
): Promise<GovernanceResult> {
  const governanceConfig = await mergeGovernanceConfigAsync(config.governance);
  const warnings: string[] = [];

  // Skip governance if disabled
  if (!governanceConfig.enabled) {
    return { allowed: true };
  }

  // 1. Check revocation status
  const revoked = await checkRevocationStatus(config.governance);
  if (revoked) {
    return {
      allowed: false,
      reason: "Access has been revoked",
    };
  }

  // 2. Check budget limits
  const budgetCheck = await checkBudgetLimits(config.governance, context.estimatedTokens || 0);
  if (!budgetCheck.allowed) {
    return {
      allowed: false,
      reason: budgetCheck.reason,
    };
  }

  // 3. Check operation permissions
  const permissionCheck = checkOperationAllowed(governanceConfig, context.operationType);
  if (!permissionCheck.allowed && !permissionCheck.requiresApproval) {
    return {
      allowed: false,
      reason: permissionCheck.reason,
    };
  }

  if (permissionCheck.requiresApproval) {
    warnings.push("This operation will require approval");
  }

  // 4. Check secret expiration
  if (governanceConfig.secrets.check_expiration && config.secrets?.keys) {
    const secretKeys = Object.keys(config.secrets.keys);
    const expirations = await checkSecretExpiration(config.governance, secretKeys, config.secrets);

    if (hasExpiredSecrets(expirations)) {
      return {
        allowed: false,
        reason: "Expired secrets detected",
        warnings,
      };
    }
  }

  return { allowed: true, warnings };
}
