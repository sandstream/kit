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

export interface OperationContext {
  operation: string;
  operationType: OperationType;
  destructive?: boolean;
  metadata?: Record<string, unknown>;
  estimatedTokens?: number;
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
