/**
 * `[policy.agent_writes]` as an ENFORCED gate — the wiring `src/policy.ts` documented as
 * NOT IMPLEMENTED, with the semantics decided rather than guessed.
 *
 * `checkPolicy` was correct, tested, and had no caller: the block was parsed, hashed into
 * `KIT_POLICY_HASH`, travelled with the repo, and changed no kit decision. This module is the
 * decision layer, kept separate from `policy.ts` so the pure predicate and the enforcement rule
 * can be read (and tested) apart.
 *
 * ── THE SEMANTIC, and why this one ────────────────────────────────────────────────────────────
 *
 * `[policy.agent_writes]` is NOT a grant. It can only ever NARROW. The reason is that this block
 * is unsigned config in `.kit.toml`: anyone — including an agent — who can edit the repo can add a
 * line to it. If declaring an op could SATISFY a gate, an agent would be able to self-approve by
 * editing config, which is precisely the failure the elevation gate and `checkSignedApproval`
 * exist to prevent. (`approval.ts` already has the grant-shaped mechanism, and it requires an
 * org-authority SIGNATURE. That is the difference.)
 *
 * So a policy decision can add a denial and never remove one. Elevation, read-only and approval
 * remain authoritative and untouched.
 *
 * ── FOUR STATES, not a boolean ────────────────────────────────────────────────────────────────
 *
 * ROADMAP warned that "absent vendor" and "present but empty" must stay distinguishable, because
 * one means unconfigured and the other means configured-to-refuse. A boolean collapses them, so
 * the return type is a four-state union and callers are forced by the compiler to handle each:
 *
 *   inert         no `[policy.agent_writes]` at all → the block is not in use; existing gates only
 *   unconfigured  block present, this vendor absent → unconfigured FOR THIS VENDOR; gates only
 *   approved      vendor present and op listed      → operator declared consent (still gated)
 *   denied        vendor present and op NOT listed  → configured to refuse. Includes `[]`.
 *
 * `stripe = []` therefore means exactly what kit's own config comment always claimed — "all writes
 * still gated" — and it means it by ENFORCEMENT now, not by hope. An empty array is truthy in JS,
 * which is why the naive `!allowed` reading of it would have been wrong.
 *
 * `unconfigured` deliberately does NOT deny. Declaring one vendor must not silently break every
 * other vendor; opting in is per-vendor, so adding `[policy.agent_writes] vercel = [...]` cannot
 * turn into an outage for github.
 */

import type { PolicyConfig } from "./config.js";

/** The state machine above. Exhaustive by construction — see the module docstring. */
export type PolicyState = "inert" | "unconfigured" | "approved" | "denied";

export interface PolicyGateDecision {
  state: PolicyState;
  /** Operator-facing explanation, safe to print. Never contains a secret value. */
  reason: string;
}

/**
 * The op VOCABULARY — a single source both sides read.
 *
 * ROADMAP trap 3: the example strings in `config.ts` (`resolve_issue`, `rotate_jwt`, `env_set`)
 * were illustrative, not a registry, and "a pre-approval list is worthless if the caller's op name
 * and the operator's spelling can differ silently". So every op kit actually gates lives here, and
 * `unknownPolicyEntries` reports config that names something kit will never ask about — a typo'd
 * `env-set` must be surfaced, not silently ignored while the operator believes it grants something.
 */
export const POLICY_OPS: readonly { vendor: string; op: string; description: string }[] =
  Object.freeze([
    {
      vendor: "vercel",
      op: "env_set",
      description: "set an environment variable on a Vercel project",
    },
    { vendor: "github", op: "env_set", description: "set an Actions secret on a GitHub repo" },
    { vendor: "fly", op: "env_set", description: "set a secret on a Fly app" },
    { vendor: "cloudflare", op: "env_set", description: "set a secret on a Cloudflare Worker" },
    { vendor: "railway", op: "env_set", description: "set a variable on a Railway service" },
    { vendor: "aws-ssm", op: "env_set", description: "put a parameter in AWS SSM Parameter Store" },
    // Supabase key rotation, registered as TWO ops because their blast radii are not comparable
    // and pre-approving the reversible one must not pre-approve the catastrophic one. This mirrors
    // the reasoning already in `elevation-scopes.ts`, where `jwt-secret-roll` needs a DISTINCT
    // elevation that a marker minted for `scoped-key-mint` cannot satisfy.
    //
    // The names mirror the `--mode` values operators actually type, so there is no translation
    // step between the flag and the policy line — a translation is exactly where the caller's
    // spelling and the operator's drift apart.
    {
      vendor: "supabase",
      op: "scoped_key_mint",
      description: "mint a new scoped Supabase key (reversible; old keys keep working)",
    },
    {
      vendor: "supabase",
      op: "jwt_secret_roll",
      description:
        "roll the Supabase JWT secret — invalidates EVERY existing token (anon, service_role, signed URLs, active sessions)",
    },
    // The revoke is a THIRD Supabase op, not a mode of the other two. `secrets-rotate-cli.ts` only
    // ever asks about `--mode`, so this surface — reachable solely through the plugin — was in
    // neither the elevation-scope split nor this registry. Its blast radius is its own: minting adds
    // a key and rolling invalidates all of them, while revoking kills ONE key that something is
    // currently authenticating with.
    {
      vendor: "supabase",
      op: "scoped_key_revoke",
      description: "revoke one scoped Supabase key — whatever is using that key loses access",
    },
    // ── The plugin ops ────────────────────────────────────────────────────────────────────────────
    //
    // These gate the write surfaces in `packages/kit-plugin-*`, which no kit-core code path can
    // reach: the plugins are standalone zero-dependency packages an agent imports directly. The
    // enforcement point therefore cannot be a kit function call — it is the deny list this module
    // exports into the environment (`policyDenyList` / `KIT_POLICY_DENY`), read by each plugin's
    // own guard. See that function for why the DECISION crosses the boundary and the CONFIG does
    // not.
    //
    // `env_unset` is registered SEPARATELY from `env_set` for the same reason the two Supabase
    // rotation modes are separate: the blast radii are not comparable. Setting a variable is
    // recoverable by setting it again; deleting one destroys the only copy of a value the operator
    // may not have anywhere else, and takes the deployment that reads it down until someone finds
    // it. A repo that pre-approved writing an env var has not pre-approved erasing one.
    {
      vendor: "vercel",
      op: "env_unset",
      description: "delete an environment variable on a Vercel project",
    },
    { vendor: "github", op: "env_unset", description: "delete an Actions secret on a GitHub repo" },
    { vendor: "fly", op: "env_unset", description: "unset a secret on a Fly app" },
    {
      vendor: "cloudflare",
      op: "env_unset",
      description: "delete a secret on a Cloudflare Worker",
    },
    {
      vendor: "vercel",
      op: "trigger_deploy",
      description: "redeploy the latest production deployment of a Vercel project",
    },
    {
      vendor: "cloudflare",
      op: "api_token_revoke",
      description: "revoke a Cloudflare API token — every consumer holding it loses access at once",
    },
    {
      vendor: "stripe",
      op: "webhook_create",
      description: "create a Stripe webhook endpoint (a new destination for live event traffic)",
    },
    {
      vendor: "stripe",
      op: "webhook_delete",
      description: "delete a Stripe webhook endpoint — events stop being delivered, silently",
    },
    // `resolve_issue` covers every issue-state write `sentry/updateIssue` performs: resolve,
    // unresolve, ignore and reassignment. They are one op rather than four because their blast
    // radii ARE comparable — all four are reversible, all four need the same `event:write` scope,
    // and none destroys data. The name is the one kit's own `kit knobs` output has always
    // advertised, which is what an operator copies; the description is what stops the name from
    // reading narrower than the op is.
    {
      vendor: "sentry",
      op: "resolve_issue",
      description:
        "write an issue's state in Sentry — resolve, unresolve, ignore (mutes alerting) or reassign",
    },
    {
      vendor: "sentry",
      op: "create_release",
      description: "create a release marker in Sentry",
    },
  ]);

/**
 * Map a Supabase `--mode` to its policy op.
 *
 * Extracted from `secrets-rotate-cli.ts` so the mapping can be PINNED. Left inline it was a
 * conditional expression inside a function that needs the Supabase Management API to reach, so a
 * mutation collapsing both modes onto one op would have been caught by nothing behavioural — the
 * registry test only proves both names exist, not that the caller picks the right one.
 *
 * The distinction is the whole point: `jwt-secret-roll` invalidates every live token, and a repo
 * that pre-approved the reversible mint must not have pre-approved that.
 */
export function supabaseRotationOp(mode: "scoped-key-mint" | "jwt-secret-roll"): string {
  return mode === "jwt-secret-roll" ? "jwt_secret_roll" : "scoped_key_mint";
}

/** Every (vendor, op) kit can gate, as `vendor:op`. */
export function knownPolicyOps(): Set<string> {
  return new Set(POLICY_OPS.map((o) => `${o.vendor}:${o.op}`));
}

/** The env var carrying the resolved denials to processes kit cannot call into. */
export const POLICY_DENY_ENV = "KIT_POLICY_DENY";

/**
 * The ops this policy REFUSES, as `vendor:op`, in registry order.
 *
 * ── Why a deny LIST and not the config ────────────────────────────────────────────────────────
 *
 * The `kit-plugin-*` packages are the enforcement points for the ops above, and they cannot call
 * this module: they are standalone zero-dependency packages, published on their own, imported
 * directly by agent code. `adapter-sdk` states the constraint — plugins must not import kit-core,
 * because that couples the monorepo and leaks private packages — and the read-only gate already
 * lives with that constraint by crossing the boundary as an ENV VAR.
 *
 * The naive way to extend that would be to serialise `[policy.agent_writes]` into the environment
 * and let each plugin apply the rule. That would put a second implementation of the four-state
 * decision in seven packages, and every one of them could collapse trap 1 (`stripe = []` is a
 * lock, not "no restrictions") or trap 2 (absent vendor ≠ present-but-empty) independently. Two
 * implementations of one access rule is the divergence class that left `kit_fix`'s MCP handler with
 * a stale copy of the lock step; seven would be worse.
 *
 * So what crosses the boundary is the DECISION, not the config. kit resolves every op in the
 * registry through `policyDecision` — the one implementation — and exports only those that came
 * back `denied`. The plugin-side guard is then a set-membership test with no rule in it and
 * therefore nothing to get wrong: there is no empty list to misread, and no absent-vendor case to
 * collapse, because both already resolved here.
 *
 * ── What this is NOT ──────────────────────────────────────────────────────────────────────────
 *
 * It is exactly as strong as the `KIT_READ_ONLY` contract and no stronger: a process that never
 * ran kit, or that strips the variable, sees no denials. That is not a weakening introduced here —
 * it is the plugin containment model kit already documents, and the alternative (plugins reading
 * `.kit.toml` themselves) needs a TOML parser in a zero-dependency package and a notion of which
 * project it belongs to, neither of which a library imported by arbitrary agent code has.
 *
 * Absence therefore means "no denial", never "denied" — which is the same narrowing-only semantic
 * the four states encode. Inverting it (absence = deny) would take every `inert` repo offline the
 * moment a plugin ran outside a kit invocation.
 *
 * One consequence worth stating plainly: a plugin-side refusal is NOT audited. `enforcePolicy`
 * records decisions into the governed project's log, and a plugin has neither that log nor a path
 * to it. The refusal is surfaced to its caller as a thrown error; the audit trail covers the ops
 * kit itself gates.
 */
export function policyDenyList(policy: PolicyConfig | undefined): string[] {
  const out: string[] = [];
  for (const { vendor, op } of POLICY_OPS) {
    if (policyDecision(policy, vendor, op).state === "denied") out.push(`${vendor}:${op}`);
  }
  return out;
}

/**
 * Resolve the denials and export them, so a plugin loaded later in this process tree refuses what
 * the operator refused. Called from `main()` alongside `installPolicyHash` — the one point where
 * kit has the governed project's config and has not yet acted on it. Idempotent.
 *
 * DELETES the variable when nothing is denied rather than setting it empty: a stale value inherited
 * from an outer kit invocation in a DIFFERENT project would otherwise refuse ops this project never
 * refused, and the operator would have no way to see why an approved call failed.
 */
export function installPolicyDenyList(policy: PolicyConfig | undefined): void {
  const denied = policyDenyList(policy);
  if (denied.length > 0) {
    process.env[POLICY_DENY_ENV] = denied.join(",");
  } else {
    delete process.env[POLICY_DENY_ENV];
  }
}

/**
 * Everything the policy exports into the environment, as ONE call from `main()`.
 *
 * Extracted from the boot block for the reason `supabaseRotationOp` was: inline in `main()` it sat
 * in code no test can reach, so dropping one of the two installs would have been caught by nothing.
 * Here a mutation that removes either one fails a behavioural test.
 *
 * The two vars answer different questions and both have to travel: the HASH identifies which policy
 * is in force (so an agent can tell whether the rules changed under it), and the DENY LIST carries
 * the decisions to code kit cannot call into.
 */
export async function installPolicyEnv(policy: PolicyConfig | undefined): Promise<void> {
  const { installPolicyHash } = await import("./policy.js");
  installPolicyHash(policy);
  installPolicyDenyList(policy);
}

/**
 * Decide, purely. No audit write, no env read, no clock — so the decision can be tested
 * exhaustively and the enforcement point stays the only thing with side effects.
 */
export function policyDecision(
  policy: PolicyConfig | undefined,
  vendor: string,
  op: string,
): PolicyGateDecision {
  const writes = policy?.agent_writes;
  if (!writes || Object.keys(writes).length === 0) {
    return { state: "inert", reason: "no [policy.agent_writes] declared — policy gate not in use" };
  }
  // Own-property guard, mirroring `checkPolicy`: a vendor named `constructor` or `__proto__` would
  // otherwise resolve to an inherited Object.prototype member and be treated as a rule.
  if (!Object.hasOwn(writes, vendor)) {
    return {
      state: "unconfigured",
      reason: `vendor "${vendor}" is not declared in [policy.agent_writes] — no policy opinion, existing gates apply`,
    };
  }
  const allowed = writes[vendor];
  if (!Array.isArray(allowed)) {
    // Fail CLOSED on a malformed entry. `vercel = "env_set"` (a string, not a list) is a config
    // mistake in an access-control block; treating it as "no rule" would be the fail-open reading.
    return {
      state: "denied",
      reason: `[policy.agent_writes.${vendor}] is not a list — refusing "${op}" rather than guessing what a malformed access rule meant`,
    };
  }
  if (!allowed.includes(op)) {
    return {
      state: "denied",
      reason:
        allowed.length === 0
          ? `[policy.agent_writes.${vendor}] is empty — the operator declared this vendor and pre-approved nothing, so "${op}" is refused`
          : `"${op}" is not in [policy.agent_writes.${vendor}] (= ${JSON.stringify(allowed)}) — refused`,
    };
  }
  return {
    state: "approved",
    reason: `"${op}" is pre-approved by [policy.agent_writes.${vendor}] — note this does NOT satisfy elevation, read-only or approval`,
  };
}

/**
 * Does the policy REFUSE this operation? The only question the enforcement point asks, because the
 * gate is narrowing-only: `approved`, `unconfigured` and `inert` are all "policy has no objection",
 * and none of them grants anything.
 */
export function policyRefuses(
  policy: PolicyConfig | undefined,
  vendor: string,
  op: string,
): PolicyGateDecision | null {
  const d = policyDecision(policy, vendor, op);
  return d.state === "denied" ? d : null;
}

/**
 * Decide AND record. The enforcement point calls this; `policyDecision` stays pure so it can be
 * tested exhaustively, and the single side effect lives here at the boundary.
 *
 * Returns the refusal (or null), same contract as `policyRefuses` — so a caller cannot accidentally
 * treat "audited" as "allowed".
 *
 * WHICH STATES ARE RECORDED, and why not all four: `denied` and `approved` are decisions the
 * operator declared and a reviewer will want in the trail — that is trap 3's "covering both grants
 * and denials". `inert` and `unconfigured` are the ABSENCE of a policy opinion, and recording them
 * would write a line for every vendor write in every repo that does not use the block, burying the
 * two states that carry information. Silence here means "the policy had nothing to say", which is
 * also what the four-state union already tells a reader of the code.
 *
 * NOT fail-closed on the audit write, deliberately: a refusal has already stopped the operation
 * before this runs, and an approval grants nothing, so a failed append cannot change any outcome —
 * it can only lose a record. The failure is surfaced on stderr rather than swallowed, matching
 * `exec-broker/broker.ts`'s audit contract.
 */
export async function enforcePolicy(
  policy: PolicyConfig | undefined,
  vendor: string,
  op: string,
  opts: { cwd?: string } = {},
): Promise<PolicyGateDecision | null> {
  const decision = policyDecision(policy, vendor, op);
  if (decision.state === "denied" || decision.state === "approved") {
    const { appendAuditEventDirect } = await import("./audit.js");
    const { hashPolicy } = await import("./policy.js");
    const logged = await appendAuditEventDirect(
      {
        operation: "policy-check",
        environment: process.env.KIT_ENV ?? process.env.NODE_ENV ?? "unknown",
        // `success` is about the POLICY DECISION, not about the vendor write: an approval is a
        // successful check, a denial is a refused one. The vendor call's own outcome is audited
        // separately by whatever wraps it.
        success: decision.state === "approved",
        metadata: {
          vendor,
          op,
          policy_state: decision.state,
          policy_hash: hashPolicy(policy),
          reason: decision.reason,
        },
      },
      { cwd: opts.cwd },
    );
    if (!logged) {
      console.error(
        `[kit] policy-check audit append failed for ${vendor}:${op} (decision: ${decision.state})`,
      );
    }
  }
  return decision.state === "denied" ? decision : null;
}

/**
 * Entries in `[policy.agent_writes]` that name an op kit never asks about.
 *
 * A typo (`env-set` for `env_set`) or an op from a vendor kit does not gate leaves the operator
 * believing they configured something. Surfacing it is the difference between a config that means
 * what it says and one that reads as if it does.
 */
export function unknownPolicyEntries(
  policy: PolicyConfig | undefined,
): { vendor: string; op: string }[] {
  const writes = policy?.agent_writes;
  if (!writes) return [];
  const known = knownPolicyOps();
  const out: { vendor: string; op: string }[] = [];
  for (const vendor of Object.keys(writes)) {
    const ops = writes[vendor];
    if (!Array.isArray(ops)) continue; // malformed shape is a denial, not an unknown op
    for (const op of ops) {
      if (!known.has(`${vendor}:${op}`)) out.push({ vendor, op });
    }
  }
  return out;
}
