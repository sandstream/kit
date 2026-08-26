/**
 * `kit broker` — the exec-broker runtime-posture surface (Pillar 3, observe→enforce adoption).
 * The runtime ladder is **off → observe → enforce**. observe runs the same gates but never
 * denies — it records each would-be denial to `.kit-audit.jsonl` (`metadata.phase === "observe"`,
 * `metadata.wouldDeny: string[]`). enforce requires `[scope].enforce_runtime = true` in the
 * SIGNED profile scope and actually denies. The gap is the human step between them: no evidence-
 * based way to answer "is it safe to flip to enforce?"
 *
 *   - `enforce-readiness` — read the observe evidence and turn the flip from a leap into a diff:
 *       `ready` (nothing observed would break), `would-block` (+ exactly what breaks), or the
 *       honest `untested` (no observe data — coverage is only what was observed, never a green).
 *   - `enforce` — the guided flip: run the readiness pre-flight, REFUSE without `--force` unless
 *       the verdict is `ready` (fail-closed — never silently enable a posture that will break the
 *       workflow), then set `[scope].enforce_runtime = true`, re-sign the profile scope, and audit
 *       the transition (`phase: "enforce-enabled"`). The re-sign is why the flip is attributable:
 *       enforce only takes effect under a valid signature.
 *
 * `enforce-readiness` reads the recorded audit log only — never executes anything. Deterministic,
 * zero-LLM. `--json` on every subcommand; `enforce-readiness --gate` turns a not-`ready` verdict
 * into a non-zero exit for CI; `enforce --force` overrides the readiness refusal.
 */
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { c } from "../utils/colors.js";
import { hasFlag } from "../utils/flags.js";
import {
  parseObserveRecords,
  assessEnforceReadiness,
  type EnforceReadiness,
} from "../exec-broker/enforce-readiness.js";

/**
 * Pure pre-flight decision for the guided flip: only a `ready` verdict flips unforced. A
 * `would-block` or `untested` verdict is REFUSED unless `--force` (fail-closed — an operator must
 * not silently enable a posture the observed evidence says will break, or that has no evidence at
 * all). Returns whether to proceed + the human reason. Deterministic, no I/O.
 */
export function enforceGateDecision(
  readiness: EnforceReadiness,
  force: boolean,
): { proceed: boolean; reason: string } {
  if (readiness.verdict === "ready") {
    return {
      proceed: true,
      reason: `${readiness.opsObserved} observed op(s), none would be denied`,
    };
  }
  if (force) {
    return { proceed: true, reason: `forced flip despite '${readiness.verdict}' (--force)` };
  }
  if (readiness.verdict === "would-block") {
    return {
      proceed: false,
      reason: `${readiness.wouldBlockOps} of ${readiness.opsObserved} observed op(s) would be denied under enforce — declare them in [scope] and re-sign, or pass --force`,
    };
  }
  return {
    proceed: false,
    reason:
      "no observe evidence yet (untested) — run under observe to gather a clean window first, or pass --force",
  };
}

const AUDIT_FILE = ".kit-audit.jsonl";

/** Read the raw audit log; a missing/unreadable file is "" → parsed as zero observe records. */
function readAuditJsonl(cwd: string): string {
  try {
    return readFileSync(resolve(cwd, AUDIT_FILE), "utf-8");
  } catch {
    return "";
  }
}

function renderReadiness(r: EnforceReadiness): void {
  console.log(`${c.bold}kit broker enforce-readiness${c.reset}`);
  switch (r.verdict) {
    case "untested":
      console.log(
        `  ${c.yellow}! untested${c.reset} ${c.dim}— no observe data in ${AUDIT_FILE}. Run under observe first; a clean window is what makes enforce safe. Not a green "ready".${c.reset}`,
      );
      return;
    case "ready":
      console.log(
        `  ${c.green}✓ ready${c.reset} ${c.dim}— ${r.opsObserved} op(s) observed, none would be denied under enforce.${c.reset}`,
      );
      console.log(
        `  ${c.dim}coverage = observed ops only ("nothing we saw would break", not "nothing ever will").${c.reset}`,
      );
      return;
    case "would-block":
      console.log(
        `  ${c.red}✗ would-block${c.reset} ${c.dim}— ${r.wouldBlockOps} of ${r.opsObserved} observed op(s) would be denied under enforce:${c.reset}`,
      );
      for (const { reason, count } of r.reasons) {
        console.log(`    ${c.yellow}⚠${c.reset} ${c.bold}${count}×${c.reset}  ${reason}`);
      }
      console.log(
        `  ${c.dim}→ declare these in [scope] and re-sign, or accept the denials knowingly, before you flip.${c.reset}`,
      );
      return;
  }
}

async function brokerEnforceReadiness(jsonMode: boolean, gate: boolean): Promise<boolean> {
  const records = parseObserveRecords(readAuditJsonl(process.cwd()));
  const readiness = assessEnforceReadiness(records);
  if (jsonMode) {
    console.log(JSON.stringify({ gate, coverage: "observed-ops-only", ...readiness }, null, 2));
    return gate ? readiness.verdict === "ready" : true;
  }
  renderReadiness(readiness);
  // Informational by default; --gate makes a not-ready verdict fail CI (untested is not ready).
  return gate ? readiness.verdict === "ready" : true;
}

/** Best-effort audit of the observe→enforce transition (design §2: the posture change is on the
 *  record). A missing .kit.toml / audit backend must never abort the flip — it already happened. */
async function auditEnforceTransition(
  cwd: string,
  opsObserved: number,
  forced: boolean,
): Promise<void> {
  try {
    const { loadConfig } = await import("../config.js");
    const { mergeGovernanceConfigAsync } = await import("../governance.js");
    const { logAuditEvent } = await import("../audit.js");
    const cfg = await loadConfig(resolve(cwd, ".kit.toml"));
    const gov = await mergeGovernanceConfigAsync(cfg.governance);
    await logAuditEvent(gov, {
      operation: "broker.enforce",
      environment: gov.environment,
      success: true,
      metadata: { phase: "enforce-enabled", opsObserved, forced },
    });
  } catch {
    /* best-effort — the flip + re-sign are the source of truth, not this log line */
  }
}

async function brokerEnforce(jsonMode: boolean, force: boolean): Promise<boolean> {
  const cwd = process.cwd();
  const { loadProfile, saveProfile } = await import("../profile/schema.js");
  const { signProfile } = await import("../profile/sign.js");

  const profile = await loadProfile(cwd);
  if (!profile?.scope) {
    const why =
      "no [scope] to enforce — declare a scope in .kit-profile.toml and `kit profile sign` first";
    if (jsonMode) console.log(JSON.stringify({ enforced: false, reason: why }, null, 2));
    else console.error(`${c.red}✗ ${why}${c.reset}`);
    return false;
  }

  const readiness = assessEnforceReadiness(parseObserveRecords(readAuditJsonl(cwd)));
  const decision = enforceGateDecision(readiness, force);
  if (!decision.proceed) {
    if (jsonMode) {
      console.log(
        JSON.stringify(
          { enforced: false, verdict: readiness.verdict, reason: decision.reason },
          null,
          2,
        ),
      );
    } else {
      console.error(
        `${c.red}✗ refusing to flip to enforce${c.reset} ${c.dim}— ${decision.reason}${c.reset}`,
      );
      for (const { reason, count } of readiness.reasons) {
        console.error(`    ${c.yellow}⚠${c.reset} ${c.bold}${count}×${c.reset}  ${reason}`);
      }
    }
    return false;
  }

  if (profile.scope.enforce_runtime === true) {
    const msg = "already enforcing ([scope].enforce_runtime = true) — nothing to do";
    if (jsonMode) console.log(JSON.stringify({ enforced: true, alreadyEnforcing: true }, null, 2));
    else console.log(`${c.green}✓${c.reset} ${c.dim}${msg}${c.reset}`);
    return true;
  }

  // Flip + re-sign: enforce only takes effect under a valid signature, so the transition is
  // attributable. On a sign failure the scope won't verify → the runtime stays effectively off
  // (not a silent enforce), and we surface it so the operator re-signs.
  profile.scope.enforce_runtime = true;
  await saveProfile(profile, cwd);
  const sig = await signProfile(cwd);
  if (!sig.ok) {
    const why = `set enforce_runtime = true, but re-signing failed (${sig.error}); the scope will not verify until signed — run \`kit profile sign\``;
    if (jsonMode)
      console.log(JSON.stringify({ enforced: false, signed: false, reason: why }, null, 2));
    else console.error(`${c.red}✗ ${why}${c.reset}`);
    return false;
  }
  await auditEnforceTransition(cwd, readiness.opsObserved, force);

  if (jsonMode) {
    console.log(
      JSON.stringify(
        { enforced: true, forced: force, fingerprint: sig.fingerprint, kid: sig.kid },
        null,
        2,
      ),
    );
    return true;
  }
  console.log(
    `${c.green}✓ enforce enabled${c.reset} ${c.dim}— ${decision.reason}; scope re-signed (${sig.fingerprint})${c.reset}`,
  );
  console.log(
    `${c.dim}the exec-broker now DENIES declared ops outside [scope]. Commit .kit-profile.toml + .kit-profile.sig.${c.reset}`,
  );
  return true;
}

export async function cmdBroker(): Promise<boolean> {
  // A flag in the subcommand slot (`kit broker --json`) means "no subcommand" → default.
  const rawSub = process.argv[3];
  const sub = !rawSub || rawSub.startsWith("-") ? "enforce-readiness" : rawSub;
  const jsonMode = hasFlag(process.argv, "--json");
  if (sub === "enforce-readiness") {
    return await brokerEnforceReadiness(jsonMode, hasFlag(process.argv, "--gate"));
  }
  if (sub === "enforce") {
    return await brokerEnforce(jsonMode, hasFlag(process.argv, "--force"));
  }
  console.error(
    `${c.red}usage: kit broker <enforce-readiness | enforce> [--json] [--gate] [--force]${c.reset}`,
  );
  return false;
}
