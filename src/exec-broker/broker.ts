// Pillar 3 — exec-broker: the enforcement wrapper.
//
// brokerExec moves governance from advisory-at-chokepoint to ENFORCED-AT-EXEC:
// it runs the three pure decision gates on an operation's DECLARED effects
// BEFORE invoking run(), default-denies when policy is absent, and audits every
// allow/deny to the existing hash-chained trail via appendAuditEventDirect.
//
// COMPOSITION: the broker gates *resources* (egress / fs / env); runGoverned
// gates *identity/budget/permission/secret-expiration*. It composes ON TOP of
// runGoverned — the caller wires `run` to it — and never rewrites it:
//
//   brokerExec(ctx, policy, () =>
//     runGoverned(config, ctx, realOp).then((o) =>
//       o.ok ? o.result : Promise.reject(new Error(o.reason))));
//
// When both audit, one operation yields two audit ops (exec-broker.* and the
// governance op) — intended, separate concerns.
//
// TRUST BOUNDARY (no false-green): context.egressTargets / fsWrites /
// envRequested must be populated HONESTLY by the tool adapter. The broker only
// gates DECLARED effects; an undeclared effect is not "allowed", it is simply
// un-mediated — so the adapter is the enforcement surface that must be reviewed.
//
// Zero LLM, zero network. Deterministic + offline.

import { existsSync } from "node:fs";
import { checkFsWriteRealpath } from "./realpath-check.js";
import type { OperationContext } from "../governance-middleware.js";
import { appendAuditEventDirect } from "../audit.js";
import { checkEgress, checkFsWrite, scopeEnv } from "./decisions.js";
import { brokerPolicyPath, loadBrokerPolicy, policyFsRoots, type BrokerPolicy } from "./policy.js";

/** Environment label stamped on broker audit entries. */
const BROKER_ENV = "exec-broker";

export interface BrokerContext extends OperationContext {
  /** Network hosts/URLs this operation intends to reach. */
  egressTargets?: string[];
  /** Filesystem paths this operation intends to write. */
  fsWrites?: string[];
  /** Environment variable names this operation needs. */
  envRequested?: string[];
  /**
   * Explicit assertion that this operation declares its effect contract — set it
   * `true` to declare "no egress/fs/env effects" (an op the broker can safely run
   * with empty gates). Providing any of the arrays above ALSO counts as declaring.
   * Without a declaration, a gated op is DENIED under an active policy (fail-closed):
   * the broker cannot mediate effects it was never told about, and silently passing
   * it is the "gates are dead code" false-green the audit flagged.
   */
  declaredEffects?: boolean;
  /**
   * Infrastructure exemption (MCP-runtime adoption step 3): this op is kit's OWN
   * tool-provisioning (e.g. `kit install`/`kit fix` shelling out to mise), NOT an
   * agent project action the `[scope]` RoE is meant to govern — it writes to the
   * toolchain's data dir under `$HOME` and fetches from tool hosts BY DESIGN, so it
   * cannot fit a project-scoped `[scope].fs`/egress. Marked ops are ALLOWED but
   * AUDITED as an explicit exemption (`exemption: "infrastructure"`) — this is the
   * honest alternative to `declaredEffects:true`, which would falsely claim the op
   * has no egress/fs effects. Set ONLY by kit's own fixed handlers, never from
   * agent-controllable input.
   */
  infrastructure?: boolean;
}

/** Did the caller declare this op's effect contract (arrays present, or a flag)? */
function hasDeclaredEffects(c: BrokerContext): boolean {
  return (
    c.declaredEffects === true ||
    c.infrastructure === true ||
    c.egressTargets !== undefined ||
    c.fsWrites !== undefined ||
    c.envRequested !== undefined
  );
}

export interface BrokerOutcome<T> {
  /** True → all gates passed and run() executed; result is set. */
  ok: boolean;
  result?: T;
  reason?: string;
  /** Populated on a gate denial: one line per denied effect. */
  denials?: string[];
  /** The declared env subset handed to run() (present on the allow path). */
  scopedEnv?: Record<string, string>;
}

/**
 * Enforce the resource gates, then run. See module doc for the composition and
 * trust-boundary contracts.
 */
export async function brokerExec<T>(
  context: BrokerContext,
  policy: BrokerPolicy | null | undefined,
  run: (scopedEnv: Record<string, string>) => Promise<T>,
  cwd?: string,
  /**
   * Why there is no policy, when the caller knows (e.g. "profile unreadable — …"). Appended to the
   * default-deny reason so the operator gets an actionable message instead of a bare "no policy".
   */
  noPolicyDetail?: string,
): Promise<BrokerOutcome<T>> {
  // Infrastructure exemption: kit's OWN tool-provisioning is not governed by the project [scope]
  // RoE (it writes to $HOME and fetches from tool hosts by design — see BrokerContext.infrastructure).
  // Allow it, but AUDIT the exemption explicitly (never a silent pass, never a false "no effects"
  // claim). Runs with full env — provisioning needs its environment. Independent of policy state:
  // the RoE does not govern this op, so its signature/validity is irrelevant here. Fail-closed
  // auditability still applies (refuse if the pre-exec authorization entry can't be written).
  if (context.infrastructure) {
    const authorized = await appendAuditEventDirect(
      {
        operation: context.operation,
        environment: BROKER_ENV,
        success: true,
        metadata: { ...context.metadata, phase: "authorized", exemption: "infrastructure" },
      },
      { cwd },
    );
    if (!authorized) {
      return {
        ok: false,
        reason: "exec-broker: audit-log unavailable; refusing to execute (fail-closed)",
      };
    }
    try {
      const result = await run(scopeEnv(Object.keys(process.env), process.env));
      await audit(context, true, undefined, { exemption: "infrastructure" }, cwd);
      return { ok: true, result };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await audit(context, false, reason, { exemption: "infrastructure" }, cwd);
      return { ok: false, reason };
    }
  }

  // Default-deny when policy is absent. run() is NEVER invoked.
  if (!policy) {
    const reason = noPolicyDetail
      ? `exec-broker: no policy (default-deny) — ${noPolicyDetail}`
      : "exec-broker: no policy (default-deny)";
    await audit(context, false, reason, undefined, cwd);
    return { ok: false, reason };
  }

  // Fail-closed on UNDECLARED effects: with a policy active, an op that never
  // declared what it touches cannot be mediated, so it is DENIED rather than
  // waved through with trivially-empty gates (the false-green the audit found).
  // A caller with genuinely no effects opts in explicitly via declaredEffects:true.
  if (!hasDeclaredEffects(context)) {
    const reason =
      "exec-broker: operation declares no effect contract (egress/fs/env) — cannot mediate (fail-closed)";
    await audit(context, false, reason, undefined, cwd);
    return { ok: false, reason };
  }

  // Collect denials across all three gates before deciding.
  const denials = collectDenials(context, policy);

  // Least privilege: hand run() ONLY the keys it actually requested (all of which
  // are, by the check above, declared) — not the whole declared set. A caller that
  // requests nothing gets nothing.
  const scopedEnv = scopeEnv(context.envRequested ?? [], process.env);

  if (denials.length > 0) {
    const reason = `exec-broker: denied (${denials.length} violation${
      denials.length === 1 ? "" : "s"
    })`;
    await audit(context, false, reason, { denials }, cwd);
    return { ok: false, reason, denials };
  }

  // Fail-closed auditability (mirrors withGovernance's destructive gate):
  // persist a pre-exec "authorized" entry and REFUSE to run if it can't be
  // written. The post-exec success log alone is fail-open.
  const authorized = await appendAuditEventDirect(
    {
      operation: context.operation,
      environment: BROKER_ENV,
      success: true,
      metadata: { ...context.metadata, phase: "authorized" },
    },
    { cwd },
  );
  if (!authorized) {
    return {
      ok: false,
      reason: "exec-broker: audit-log unavailable; refusing to execute (fail-closed)",
    };
  }

  // All gates passed → execute with the scoped env, then audit success/failure.
  try {
    const result = await run(scopedEnv);
    await audit(context, true, undefined, undefined, cwd);
    return { ok: true, result, scopedEnv };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await audit(context, false, reason, undefined, cwd);
    return { ok: false, reason };
  }
}

/**
 * OBSERVE (dry-run) enforcement — Pillar 3 default-on ladder. Run the SAME gates as brokerExec over
 * the declared effects, but NEVER deny: record the would-be denials to the audit trail
 * (`phase: "observe"`, `wouldDeny`) and always execute with the FULL env (behavior-neutral — observe
 * must not alter what the op sees). A null policy (unverified scope) is reported as the default-deny
 * that enforce mode WOULD apply, so an operator sees "this op would be denied under enforce" without
 * anything actually breaking. Never a false green: the op is audited as observed, not as mediated.
 */
async function brokerObserve<T>(
  context: BrokerContext,
  policy: BrokerPolicy | null | undefined,
  run: (scopedEnv: Record<string, string>) => Promise<T>,
  cwd?: string,
): Promise<BrokerOutcome<T>> {
  const wouldDeny = policy
    ? collectDenials(context, policy)
    : ["exec-broker: no policy (default-deny)"];
  await audit(context, true, undefined, { phase: "observe", wouldDeny }, cwd);
  try {
    const result = await run(scopeEnv(Object.keys(process.env), process.env));
    return { ok: true, result };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Run all three resource gates over an operation's DECLARED effects and return one
 * denial line per violation (empty array = all gates passed). Extracted from
 * brokerExec so the enforcement wrapper stays simple. fs-write is checked twice:
 * the pure string/traversal gate, then the impure realpath symlink gate.
 */
function collectDenials(context: BrokerContext, policy: BrokerPolicy): string[] {
  const denials: string[] = [];

  for (const target of context.egressTargets ?? []) {
    const d = checkEgress(target, { allow: policy.egress.allow });
    if (!d.ok) denials.push(d.reason ?? `egress denied: ${target}`);
  }

  const roots = policyFsRoots(policy);
  for (const path of context.fsWrites ?? []) {
    // Allowed iff SOME root passes BOTH the pure traversal gate AND the symlink-aware gate.
    // Denied only when every root rejects it; report the primary root's reason for clarity.
    const allowed = roots.some(
      (root) => checkFsWrite(path, root).ok && checkFsWriteRealpath(path, root).ok,
    );
    if (!allowed) {
      const d = checkFsWrite(path, policy.fs.root);
      const sl = d.ok ? checkFsWriteRealpath(path, policy.fs.root) : d;
      denials.push(
        (!d.ok ? d.reason : sl.reason) ??
          `fs-write denied: ${path} outside ${roots.length} allowed root(s)`,
      );
    }
  }

  for (const key of context.envRequested ?? []) {
    if (!policy.env.declared.includes(key)) {
      denials.push(`env: requested key ${key} not declared in policy`);
    }
  }

  return denials;
}

/**
 * OPT-IN entry point. Policy-source precedence (reconciliation §4 / MCP-runtime adoption):
 *
 *   1. SIGNED profile scope with `[scope].enforce_runtime = true` (the explicit runtime opt-in):
 *      - op DECLARES its effects → mediate against the signed policy (`policy` is null when the
 *        scope is unsigned/tampered, so `brokerExec` default-DENIES — fail-closed);
 *      - op declares NO effects → MIGRATION passthrough. A governed op is only mediated at the
 *        runtime once it honestly declares what it touches; until each op opts in, its behavior is
 *        unchanged (deliberate — see `pillar3-mcp-runtime-adoption-5.0.md` §5 step 1). This is NOT
 *        the false-green of a JSON policy waving an undeclared op through: that path stays
 *        fail-closed below.
 *   2. Else the unsigned `.kit-exec-broker.json` (nor `KIT_EXEC_BROKER_POLICY`):
 *      - absent → run UNMEDIATED (the original opt-in switch — a fresh install is never gated);
 *      - present but malformed → `loadBrokerPolicy` returns null → `brokerExec` default-DENIES;
 *      - present + valid → full `brokerExec` mediation.
 *
 * This is the drop-in every call site adopts to become broker-aware without changing behavior for
 * users who haven't opted in to EITHER source.
 */
export async function runBrokered<T>(
  context: BrokerContext,
  run: (scopedEnv: Record<string, string>) => Promise<T>,
  opts: { policyOverride?: string; cwd?: string } = {},
): Promise<BrokerOutcome<T>> {
  // 1. Signed profile scope at the runtime — only when the scope explicitly opted in.
  const { profileBrokerPolicy } = await import("./profile-policy.js");
  const signed = await profileBrokerPolicy(opts.cwd ?? process.cwd());
  if (signed.runtimeMode !== "off") {
    if (hasDeclaredEffects(context)) {
      // "observe" = dry-run: mediate the same gates but NEVER deny — record would-be denials so an
      // operator can see what default-on would block before flipping to "enforce" (Pillar 3 ladder).
      return signed.runtimeMode === "observe"
        ? brokerObserve(context, signed.policy, run, opts.cwd)
        : brokerExec(
            context,
            signed.policy,
            run,
            opts.cwd,
            signed.policy === null ? signed.detail : undefined,
          );
    }
    // Undeclared op under runtime enforcement/observe → migration passthrough (unchanged behavior).
    try {
      return { ok: true, result: await run(scopeEnv(Object.keys(process.env), process.env)) };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  // 2. Unsigned JSON policy (original opt-in via file presence).
  if (!existsSync(brokerPolicyPath(opts.policyOverride))) {
    // Not configured → unmediated passthrough (full env, no scoping).
    try {
      return { ok: true, result: await run(scopeEnv(Object.keys(process.env), process.env)) };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }
  return brokerExec(context, loadBrokerPolicy(opts.policyOverride), run, opts.cwd);
}

/**
 * Best-effort audit of a broker decision. A DENY still returns deny even if this
 * append fails (we never fail-open to allow) — but surface the logging failure to
 * stderr, as audit.ts does, so the denial is not silently unlogged.
 *
 * `cwd` is the GOVERNED PROJECT's directory: broker evidence belongs to the
 * project whose [scope] mediates the op, not to whatever process.cwd() happens
 * to be (an MCP server's cwd, the test runner's repo root, ...). Without this,
 * observe records from other projects — including test fixtures — pollute the
 * host repo's .kit-audit.jsonl and poison `kit broker enforce-readiness`, whose
 * verdict is only as honest as the evidence file it reads.
 */
async function audit(
  context: BrokerContext,
  success: boolean,
  error: string | undefined,
  extra?: Record<string, unknown>,
  cwd?: string,
): Promise<void> {
  const logged = await appendAuditEventDirect(
    {
      operation: context.operation,
      environment: BROKER_ENV,
      success,
      error,
      metadata: extra ? { ...context.metadata, ...extra } : context.metadata,
    },
    { cwd },
  );
  if (!logged) {
    console.error(`[kit] exec-broker: audit append failed for ${context.operation}`);
  }
}
