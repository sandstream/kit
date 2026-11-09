import { resolve } from "node:path";
import type { kitConfig } from "./config.js";
import {
  mergeGovernanceConfigAsync,
  checkOperationAllowed,
  type OperationType,
} from "./governance.js";
import { checkRevocationAccess } from "./revocation.js";
import { BudgetRefundError, checkBudgetLimits, withBudget } from "./budget.js";
import { logAuditEvent } from "./audit.js";
import { requestApproval } from "./approval.js";
import {
  checkSecretExpiration,
  hasSecretWarnings,
  formatSecretExpirationWarnings,
  hasExpiredSecrets,
} from "./secret-expiration.js";
import { checkScopeNeeds, type ScopeNeeds } from "./exec-broker/scope-needs.js";
import type { BrokerContext } from "./exec-broker/broker.js";

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

export interface GovernanceOptions<T> {
  cwd?: string;
  /**
   * Interpret a returned result for the audit. Without this callback, any normal return means success.
   * withGovernance preserves the result. runGoverned returns ok:false with the result when assessment fails.
   * Allowance is charged before execution. Returned failures keep it; thrown errors refund when storage permits.
   */
  assessResult?: (result: T) => { success: boolean; error?: string };
}

function assessResult<T>(result: T, opts: GovernanceOptions<T>): GovernedOutcome<T> {
  const outcome = opts.assessResult?.(result);
  return outcome && !outcome.success
    ? { ok: false, result, reason: outcome.error ?? "Operation reported failure" }
    : { ok: true, result };
}

function failureMetadata(
  context: OperationContext,
  error: unknown,
): Record<string, unknown> | undefined {
  if (!(error instanceof BudgetRefundError)) return context.metadata;
  return {
    ...context.metadata,
    phase: "budget-refund-failed",
    operation_success: false,
    operation_error:
      error.operationError instanceof Error
        ? error.operationError.message
        : String(error.operationError),
  };
}

type MergedGovernance = Awaited<ReturnType<typeof mergeGovernanceConfigAsync>>;

/** Audit a thrown operation error and return its message. */
async function auditThrown(
  governanceConfig: MergedGovernance,
  context: OperationContext,
  err: unknown,
  startTime: number,
  cwd: string | undefined,
): Promise<string> {
  const error = err instanceof Error ? err.message : String(err);
  await logAuditEvent(
    governanceConfig,
    {
      operation: context.operation,
      environment: governanceConfig.environment,
      success: false,
      duration_ms: Date.now() - startTime,
      error,
      metadata: failureMetadata(context, err),
    },
    { cwd },
  );
  return error;
}

/** Audit an operation that returned, with the outcome its result was assessed to. */
async function auditAssessed<T>(
  governanceConfig: MergedGovernance,
  context: OperationContext,
  outcome: GovernedOutcome<T>,
  startTime: number,
  cwd: string | undefined,
): Promise<void> {
  await logAuditEvent(
    governanceConfig,
    {
      operation: context.operation,
      environment: governanceConfig.environment,
      success: outcome.ok,
      error: outcome.reason,
      duration_ms: Date.now() - startTime,
      metadata: context.metadata,
    },
    { cwd },
  );
}

/**
 * Execute an operation with full governance checks
 */
export async function withGovernance<T>(
  config: kitConfig,
  context: OperationContext,
  operation: () => Promise<T>,
  opts: GovernanceOptions<T> = {},
): Promise<T> {
  opts = { ...opts, cwd: resolve(opts.cwd ?? process.cwd()) };
  const startTime = Date.now();
  const governanceConfig = await mergeGovernanceConfigAsync(config.governance, opts.cwd);

  // Skip governance if disabled
  if (!governanceConfig.enabled) {
    return await operation();
  }

  // Audit a denied operation with the shared event shape. DRYs the 5 pre-execute
  // deny paths below — each fails closed (audit, then throw).
  const auditDeny = (error: string, extra?: Record<string, unknown>) =>
    logAuditEvent(
      governanceConfig,
      {
        operation: context.operation,
        environment: governanceConfig.environment,
        success: false,
        error,
        metadata: extra ? { ...context.metadata, ...extra } : context.metadata,
      },
      { cwd: opts.cwd },
    );

  // 1. Check revocation status
  const revocation = await checkRevocationAccess(config.governance, opts);
  if (!revocation.allowed) {
    await auditDeny(revocation.reason);
    throw new Error(revocation.reason);
  }

  // 2. Check budget limits
  const budgetCheck = await checkBudgetLimits(
    config.governance,
    context.estimatedTokens || 0,
    opts,
  );
  if (!budgetCheck.allowed) {
    await auditDeny(budgetCheck.reason || "Budget limit exceeded");
    throw new Error(budgetCheck.reason || "Budget limit exceeded");
  }

  // 2.5 Scope enforcement (exec-broker, Pillar 3): declared needs vs the signed [scope]/RoE.
  //     Checked BEFORE any approval prompt — a scope denial is not operator-overridable (the
  //     RoE is a signed artifact; widening it means editing + re-signing the profile), so the
  //     operator is never prompted to approve an operation that will be scope-denied anyway.
  if (context.scopeNeeds) {
    const scopeDenial = await checkScopeNeeds(context.scopeNeeds, opts.cwd);
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

    // Approaching expiry: WARN, never block. Before this, `hasSecretWarnings` had no
    // caller at all (self-audit rule 15) and the warning window was silent — a key
    // expiring in three days produced no output until the day it started blocking
    // operations, which is the wrong end of the runway to find out. Same observe→enforce
    // shape as the rest of kit: the enforce half already worked, the observe half was
    // written and never wired.
    if (hasSecretWarnings(expirations)) {
      console.warn("\n" + formatSecretExpirationWarnings(expirations));
    }
  }

  // Fail-closed auditability for DESTRUCTIVE ops: persist an authorization entry
  // BEFORE executing and refuse if it can't be written. The post-execution
  // success log alone is fail-open (the op would run unlogged if the audit
  // append failed) — this closes that gap for the operations that matter most.
  if (context.destructive) {
    const logged = await logAuditEvent(
      governanceConfig,
      {
        operation: context.operation,
        environment: governanceConfig.environment,
        success: true,
        metadata: { ...context.metadata, phase: "authorized" },
      },
      { cwd: opts.cwd },
    );
    if (!logged) {
      throw new Error("audit-log unavailable; refusing destructive operation (fail-closed)");
    }
  }

  // Execute the operation
  let execution: { value: T; outcome: GovernedOutcome<T> };

  try {
    execution = await withBudget(
      config.governance,
      context.estimatedTokens ?? 0,
      async () => {
        const value = await operation();
        return { value, outcome: assessResult(value, opts) };
      },
      opts,
    );
  } catch (err) {
    await auditThrown(governanceConfig, context, err, startTime, opts.cwd);
    throw err;
  }

  // Admission was charged before execution. Record the actual assessed outcome.
  await auditAssessed(governanceConfig, context, execution.outcome, startTime, opts.cwd);
  return execution.value;
}

export interface GovernedOutcome<T> {
  /** False means denial, a thrown error, or an assessed failure. Assessed failures retain result. */
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
  opts: GovernanceOptions<T> = {},
): Promise<GovernedOutcome<T>> {
  opts = { ...opts, cwd: resolve(opts.cwd ?? process.cwd()) };
  const startTime = Date.now();
  const governanceConfig = await mergeGovernanceConfigAsync(config.governance, opts.cwd);

  // Governance disabled → run, no audit (nothing is being governed).
  if (!governanceConfig.enabled) {
    try {
      return assessResult(await operation(), opts);
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  const auditDeny = (error: string, extra?: Record<string, unknown>) =>
    logAuditEvent(
      governanceConfig,
      {
        operation: context.operation,
        environment: governanceConfig.environment,
        success: false,
        error,
        metadata: extra ? { ...context.metadata, ...extra } : context.metadata,
      },
      { cwd: opts.cwd },
    );

  // 1. Revocation
  const revocation = await checkRevocationAccess(config.governance, opts);
  if (!revocation.allowed) {
    await auditDeny(revocation.reason);
    return { ok: false, reason: revocation.reason };
  }

  // 2. Budget
  const budgetCheck = await checkBudgetLimits(
    config.governance,
    context.estimatedTokens || 0,
    opts,
  );
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
    const outcome = await withBudget(
      config.governance,
      context.estimatedTokens ?? 0,
      async () => assessResult(await operation(), opts),
      opts,
    );
    await auditAssessed(governanceConfig, context, outcome, startTime, opts.cwd);
    return outcome;
  } catch (err) {
    return {
      ok: false,
      reason: await auditThrown(governanceConfig, context, err, startTime, opts.cwd),
    };
  }
}

/**
 * {@link runGoverned} with the Pillar 3 exec-broker composed ON TOP. The broker
 * gates an operation's declared RESOURCE effects (egress / fs-write / env)
 * BEFORE governance (identity / budget / permission) runs; the two are separate
 * concerns that stack.
 *
 * OPT-IN and non-breaking: `runBrokered` is a passthrough unless a policy source is opted into —
 * a signed profile scope with `[scope].enforce_runtime = true`, or a `.kit-exec-broker.json` /
 * `KIT_EXEC_BROKER_POLICY` file. A call site swapping `runGoverned` → `runGovernedBrokered`
 * behaves IDENTICALLY until a user opts in. A present-but-malformed policy fails closed (deny).
 * Returns the same {@link GovernedOutcome} shape callers already render.
 *
 * `opts.cwd` is the project directory whose signed profile governs — pass the tool's own `cwd`
 * (not the process cwd) so the RIGHT project's `[scope]` is resolved. Defaults to `process.cwd()`.
 */
export async function runGovernedBrokered<T>(
  config: kitConfig,
  context: BrokerContext,
  operation: () => Promise<T>,
  opts: GovernanceOptions<T> = {},
): Promise<GovernedOutcome<T>> {
  opts = { ...opts, cwd: resolve(opts.cwd ?? process.cwd()) };
  const { runBrokered } = await import("./exec-broker/index.js");
  let assessedFailure: GovernedOutcome<T> | undefined;
  const outcome = await runBrokered(
    context,
    async () => {
      const gov = await runGoverned(config, context, operation, opts);
      // Let the broker audit failure while preserving a returned action result for the caller.
      if (!gov.ok) {
        if ("result" in gov) assessedFailure = gov;
        throw new Error(gov.reason ?? "denied");
      }
      return gov.result as T;
    },
    { cwd: opts.cwd },
  );
  if (!outcome.ok && assessedFailure) return assessedFailure;
  return outcome.ok ? { ok: true, result: outcome.result } : { ok: false, reason: outcome.reason };
}

/**
 * Perform pre-flight checks without executing the operation
 */
export async function checkGovernance(
  config: kitConfig,
  context: OperationContext,
  opts: { cwd?: string } = {},
): Promise<GovernanceResult> {
  opts = { ...opts, cwd: resolve(opts.cwd ?? process.cwd()) };
  const governanceConfig = await mergeGovernanceConfigAsync(config.governance, opts.cwd);
  const warnings: string[] = [];

  // Skip governance if disabled
  if (!governanceConfig.enabled) {
    return { allowed: true };
  }

  // 1. Check revocation status
  const revocation = await checkRevocationAccess(config.governance, opts);
  if (!revocation.allowed) return revocation;

  // 2. Check budget limits
  const budgetCheck = await checkBudgetLimits(
    config.governance,
    context.estimatedTokens || 0,
    opts,
  );
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
