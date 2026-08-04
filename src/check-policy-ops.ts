/**
 * The `kit check` row for `[policy.agent_writes]` — the surfacing four documents already claimed.
 *
 * `unknownPolicyEntries()` was written, unit-tested, and had NO production caller. Meanwhile
 * `config.ts` told operators "`kit check` surfaces an entry naming an op kit never asks about",
 * `docs/OWASP_2025.md` cited it as evidence for the A01 row, and ROADMAP + CHANGELOG both described
 * it as reporting. It reported to nobody.
 *
 * Measured before writing this: a repo whose `.kit.toml` contained
 *
 *   [policy.agent_writes]
 *   vercel = ["env-set"]        # typo
 *   sentry = ["resolve_issue"]  # not in the registry at the time
 *
 * produced a full `kit check` with zero mention of either line, exit 0. The operator's belief that
 * they had pre-approved something was never contradicted, and the typo silently turned into the
 * opposite of what they wrote: `vercel` is now a DECLARED vendor whose real op `env_set` is not in
 * the list, so propagation is refused. A misspelling flips an approval into a denial, quietly.
 *
 * This is the same defect as the one the previous arc fixed one module over — a correct decision
 * function with no caller — which is why trap 5 says tests over the decision function are not
 * evidence of a working control. So this check is wired into `checkSecurity()`, the single function
 * every surface (`kit check`, `kit ci`, `kit heal`, `kit coverage`, MCP) calls: putting it in
 * `runCheckGate` instead would have left `kit ci` — the gate that runs unattended — silent.
 */

import type { SecurityCheckResult } from "./check-security.js";

/**
 * Report on the project's `[policy.agent_writes]` block.
 *
 * `cwd` is the GOVERNED project's root and is not optional in spirit: resolving `.kit.toml` from
 * `process.cwd()` here would reproduce exactly the bug the cwd-threading arc fixed, reporting on the
 * calling process's tree while the caller supplied another.
 */
export async function checkPolicyAgentWrites(cwd?: string): Promise<SecurityCheckResult> {
  const name = "policy agent-writes";
  const category = "secrets" as const;

  const { resolve } = await import("node:path");
  const { existsSync } = await import("node:fs");
  const configPath = resolve(cwd ?? process.cwd(), ".kit.toml");

  // No config at all is an honest not-applicable skip, NOT `didNotRun` — there is no policy to
  // report on. A config that exists but cannot be read IS `didNotRun`: the check was meant to run
  // and could not, which the strict CI gate should fail rather than read as green.
  if (!existsSync(configPath)) {
    return { category, name, status: "skip", detail: "no .kit.toml — no policy to report on" };
  }

  const { loadConfig } = await import("./config.js");
  let policy;
  try {
    policy = (await loadConfig(configPath)).policy;
  } catch (err) {
    return {
      category,
      name,
      status: "warn",
      severity: "medium",
      didNotRun: true,
      detail: `.kit.toml present but not loadable, so [policy.agent_writes] could not be checked: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  const writes = policy?.agent_writes;
  if (!writes || Object.keys(writes).length === 0) {
    return {
      category,
      name,
      status: "skip",
      detail: "no [policy.agent_writes] declared — policy gate not in use",
    };
  }

  const { unknownPolicyEntries, policyDenyList, POLICY_OPS } = await import("./policy-gate.js");
  const unknown = unknownPolicyEntries(policy);
  const denied = policyDenyList(policy);

  if (unknown.length > 0) {
    // Name the nearest real ops for each offending vendor. A typo is the common case and the
    // operator's next question is always "then what is it called?" — answering it in the finding is
    // the difference between a warning they can act on and one they have to go read source for.
    const detail = unknown
      .map(({ vendor, op }) => {
        const real = POLICY_OPS.filter((o) => o.vendor === vendor).map((o) => o.op);
        const hint =
          real.length > 0
            ? `known for ${vendor}: ${real.join(", ")}`
            : "kit gates no ops for this vendor";
        return `${vendor} = ["${op}"] (${hint})`;
      })
      .join("; ");
    return {
      category,
      name,
      status: "warn",
      severity: "medium",
      detail: `[policy.agent_writes] names ${unknown.length} op(s) kit never asks about, so ${
        unknown.length === 1 ? "it grants" : "they grant"
      } nothing — and the vendor is still DECLARED, which refuses its real ops: ${detail}`,
      suggestion:
        "Fix the op name to one kit gates (see POLICY_OPS in src/policy-gate.ts, or `kit knobs`). An entry kit does not recognise cannot pre-approve anything, while declaring the vendor turns every unlisted op into a refusal.",
    };
  }

  const approved = Object.values(writes).reduce((n, ops) => n + ops.length, 0);
  return {
    category,
    name,
    status: "pass",
    detail: `${approved} op(s) pre-approved across ${Object.keys(writes).length} vendor(s); policy refuses ${denied.length} of the ${POLICY_OPS.length} ops kit gates`,
  };
}
