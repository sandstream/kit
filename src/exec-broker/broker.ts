// Pelare 3 — exec-broker: the enforcement wrapper.
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

import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import type { OperationContext } from "../governance-middleware.js";
import { appendAuditEventDirect } from "../audit.js";
import { checkEgress, checkFsWrite, scopeEnv } from "./decisions.js";
import type { BrokerPolicy } from "./policy.js";

/** Environment label stamped on broker audit entries. */
const BROKER_ENV = "exec-broker";

export interface BrokerContext extends OperationContext {
  /** Network hosts/URLs this operation intends to reach. */
  egressTargets?: string[];
  /** Filesystem paths this operation intends to write. */
  fsWrites?: string[];
  /** Environment variable names this operation needs. */
  envRequested?: string[];
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
): Promise<BrokerOutcome<T>> {
  // Default-deny when policy is absent. run() is NEVER invoked.
  if (!policy) {
    const reason = "exec-broker: no policy (default-deny)";
    await audit(context, false, reason);
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
    await audit(context, false, reason, { denials });
    return { ok: false, reason, denials };
  }

  // Fail-closed auditability (mirrors withGovernance's destructive gate):
  // persist a pre-exec "authorized" entry and REFUSE to run if it can't be
  // written. The post-exec success log alone is fail-open.
  const authorized = await appendAuditEventDirect({
    operation: context.operation,
    environment: BROKER_ENV,
    success: true,
    metadata: { ...context.metadata, phase: "authorized" },
  });
  if (!authorized) {
    return {
      ok: false,
      reason: "exec-broker: audit-log unavailable; refusing to execute (fail-closed)",
    };
  }

  // All gates passed → execute with the scoped env, then audit success/failure.
  try {
    const result = await run(scopedEnv);
    await audit(context, true, undefined);
    return { ok: true, result, scopedEnv };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await audit(context, false, reason);
    return { ok: false, reason };
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

  for (const path of context.fsWrites ?? []) {
    const d = checkFsWrite(path, policy.fs.root);
    if (!d.ok) {
      denials.push(d.reason ?? `fs-write denied: ${path}`);
      continue;
    }
    const sl = checkFsWriteRealpath(path, policy.fs.root);
    if (!sl.ok) denials.push(sl.reason ?? `fs-write symlink-escape denied: ${path}`);
  }

  for (const key of context.envRequested ?? []) {
    if (!policy.env.declared.includes(key)) {
      denials.push(`env: requested key ${key} not declared in policy`);
    }
  }

  return denials;
}

/**
 * Symlink-aware fs-write check (impure companion to the pure decisions.checkFsWrite).
 * Realpath the nearest EXISTING ancestor of the resolved target and confirm it is
 * the real root or strictly under it — catching a symlink inside the root that
 * points outside. The not-yet-existing tail of the path cannot contain symlinks
 * (nothing is there to be one). Any fs/realpath error → fail-closed deny.
 */
function checkFsWriteRealpath(path: string, projectRoot: string): { ok: boolean; reason?: string } {
  try {
    const root = realpathSync(resolve(projectRoot));
    let cur = resolve(root, path);
    while (!existsSync(cur)) {
      const parent = dirname(cur);
      if (parent === cur) break; // reached the filesystem root
      cur = parent;
    }
    const real = realpathSync(cur);
    if (real === root || real.startsWith(root + sep)) return { ok: true };
    return { ok: false, reason: `fs-write: real path ${real} escapes root ${root}` };
  } catch {
    return { ok: false, reason: "fs-write: realpath check failed (fail-closed)" };
  }
}

/**
 * Best-effort audit of a broker decision. A DENY still returns deny even if this
 * append fails (we never fail-open to allow) — but surface the logging failure to
 * stderr, as audit.ts does, so the denial is not silently unlogged.
 */
async function audit(
  context: BrokerContext,
  success: boolean,
  error: string | undefined,
  extra?: Record<string, unknown>,
): Promise<void> {
  const logged = await appendAuditEventDirect({
    operation: context.operation,
    environment: BROKER_ENV,
    success,
    error,
    metadata: extra ? { ...context.metadata, ...extra } : context.metadata,
  });
  if (!logged) {
    console.error(`[kit] exec-broker: audit append failed for ${context.operation}`);
  }
}
