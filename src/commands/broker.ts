/**
 * `kit broker` — the exec-broker runtime-posture surface (Pillar 3, observe→enforce adoption).
 * The runtime ladder is **off → observe → enforce**. observe runs the same gates but never
 * denies — it records each would-be denial to `.kit-audit.jsonl` (`metadata.phase === "observe"`,
 * `metadata.wouldDeny: string[]`). enforce requires `[scope].enforce_runtime = true` in the
 * SIGNED profile scope and actually denies. The gap is the human step between them: no evidence-
 * based way to answer "is it safe to flip to enforce?"
 *
 *   - `enforce-readiness` — read the observe evidence and turn the flip from a leap into a diff:
 *       `ready`, `would-block`, `untested` (no observe data), or `unverifiable` (failed log check).
 *   - `enforce` — the guided flip: run the readiness pre-flight, REFUSE without `--force` unless
 *       the verdict is `ready` (fail-closed — never silently enable a posture that will break the
 *       workflow). Record the request when auditing is enabled. Sign and verify the updated
 *       profile. Record the completed transition after the updated profile verifies.
 *
 * `enforce-readiness` reads the recorded audit log only — never executes anything. Deterministic,
 * zero-LLM. `--json` on every subcommand; `enforce-readiness --gate` turns a not-`ready` verdict
 * into a non-zero exit for CI. `enforce --force` overrides the readiness refusal.
 */
import { randomUUID } from "node:crypto";
import { c } from "../utils/colors.js";
import { hasFlag } from "../utils/flags.js";
import type { EnforceReadiness } from "../exec-broker/enforce-readiness.js";
import type { KitProfile } from "../profile/schema.js";
import type { ProfileSignResult } from "../profile/sign.js";
import {
  BROKER_AUDIT_FILE,
  describeUntestedObserveEvidence,
  readObserveReadiness,
} from "../exec-broker/observe-evidence.js";
import {
  reconcileBrokerEnforceAudit,
  startBrokerEnforceAudit,
  type EnforceAuditStatus,
} from "./broker-enforce-audit.js";

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
  if (readiness.verdict === "unverifiable") {
    return {
      proceed: false,
      reason: `Cannot verify ${BROKER_AUDIT_FILE}: ${readiness.evidenceBreak}. Inspect the broker log with 'kit audit verify', or pass --force.`,
    };
  }
  return {
    proceed: false,
    reason: `${describeUntestedObserveEvidence(readiness.untestedReason)}. Run the workflow in observe mode first, or pass --force.`,
  };
}

function renderReadiness(r: EnforceReadiness): void {
  console.log(`${c.bold}kit broker enforce-readiness${c.reset}`);
  switch (r.verdict) {
    case "untested":
      console.log(
        `  ${c.yellow}! untested${c.reset} ${c.dim}${describeUntestedObserveEvidence(r.untestedReason)}. Run the workflow in observe mode first.${c.reset}`,
      );
      return;
    case "unverifiable":
      console.log(
        `  ${c.red}✗ unverifiable${c.reset} ${c.dim}Cannot verify ${BROKER_AUDIT_FILE}: ${r.evidenceBreak}. Inspect the broker log with 'kit audit verify'.${c.reset}`,
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
  const readiness = await readObserveReadiness(process.cwd());
  if (jsonMode) {
    console.log(JSON.stringify({ gate, coverage: "observed-ops-only", ...readiness }, null, 2));
    return gate ? readiness.verdict === "ready" : true;
  }
  renderReadiness(readiness);
  // Informational by default; --gate makes a not-ready verdict fail CI (untested is not ready).
  return gate ? readiness.verdict === "ready" : true;
}

async function verifiedEnforceSignature(cwd: string, fingerprint: string) {
  const { verifyProfileSignature } = await import("../profile/sign.js");
  const verified = await verifyProfileSignature(cwd).catch(() => null);
  return verified?.status === "valid" && verified.fingerprint === fingerprint ? verified : null;
}

async function publishEnforceProfile(
  cwd: string,
  profile: KitProfile,
  expectedBytes: string,
  requestId: string,
): Promise<ProfileSignResult> {
  try {
    const { signProfile } = await import("../profile/sign.js");
    const signed = await signProfile(cwd, { profile, expectedBytes, requestId });
    if (!signed.ok) return signed;
    const verified = signed.fingerprint
      ? await verifiedEnforceSignature(cwd, signed.fingerprint)
      : null;
    if (verified?.enforcementRequestId !== requestId) {
      return { ok: false, error: "The published profile signature could not be verified." };
    }
    return signed;
  } catch {
    return { ok: false, error: "Could not write or verify the profile and signature." };
  }
}

function refuseEnforcement(jsonMode: boolean, reason: string, signed?: false): false {
  if (jsonMode) console.log(JSON.stringify({ enforced: false, reason, signed }, null, 2));
  else console.error(`${c.red}✗ ${reason}${c.reset}`);
  return false;
}

function refuseReadiness(jsonMode: boolean, readiness: EnforceReadiness, reason: string): false {
  if (jsonMode) {
    console.log(
      JSON.stringify(
        {
          enforced: false,
          verdict: readiness.verdict,
          untestedReason: readiness.untestedReason,
          reason,
        },
        null,
        2,
      ),
    );
  } else {
    console.error(
      `${c.red}✗ Refusing to enable enforcement.${c.reset} ${c.dim}${reason}${c.reset}`,
    );
    for (const { reason, count } of readiness.reasons) {
      console.error(`    ${c.yellow}⚠${c.reset} ${c.bold}${count}×${c.reset}  ${reason}`);
    }
  }
  return false;
}

function reportEnabled(
  jsonMode: boolean,
  signature: { fingerprint?: string; kid?: string },
  audit: EnforceAuditStatus,
  action: { alreadyEnforcing: true } | { reason: string; forced: boolean },
): boolean {
  const incomplete = audit === "incomplete";
  const alreadyEnforcing = "alreadyEnforcing" in action;
  const failure = "Enforce is active. The audit log is missing the completed transition.";
  if (jsonMode) {
    console.log(
      JSON.stringify(
        {
          enforced: true,
          alreadyEnforcing: alreadyEnforcing || undefined,
          forced: alreadyEnforcing ? undefined : action.forced,
          fingerprint: signature.fingerprint,
          kid: signature.kid,
          audit,
          reason: incomplete ? failure : undefined,
        },
        null,
        2,
      ),
    );
  } else if (incomplete) {
    console.error(`${c.red}✗ ${failure}${c.reset}`);
  } else {
    const reason = alreadyEnforcing ? "The signed profile already enables enforce." : action.reason;
    console.log(`${c.green}✓ ${reason}${c.reset}`);
    if (audit === "disabled") console.log("Audit logging is disabled for this project.");
    console.log(`Commit .kit-profile.toml and .kit-profile.sig (${signature.fingerprint}).`);
  }
  return !incomplete;
}

async function brokerEnforce(jsonMode: boolean, force: boolean): Promise<boolean> {
  const cwd = process.cwd();
  const { canonicalProfileBytes, loadProfile, profileDigest, profileFingerprint } =
    await import("../profile/schema.js");

  const profile = await loadProfile(cwd);
  if (!profile?.scope) {
    return refuseEnforcement(
      jsonMode,
      "There is no [scope] in .kit-profile.toml. Declare a scope and run 'kit profile sign'.",
    );
  }

  if (profile.scope.enforce_runtime === true) {
    const fingerprint = profileFingerprint(profile);
    const signature = await verifiedEnforceSignature(cwd, fingerprint);
    if (!signature) {
      return refuseEnforcement(
        jsonMode,
        "The enforcement profile has no valid signature. Run 'kit profile verify'.",
      );
    }
    const audit = await reconcileBrokerEnforceAudit(
      cwd,
      signature.enforcementRequestId,
      profileDigest(profile),
    );
    return reportEnabled(jsonMode, signature, audit, { alreadyEnforcing: true });
  }

  const readiness = await readObserveReadiness(cwd);
  const decision = enforceGateDecision(readiness, force);
  if (!decision.proceed) return refuseReadiness(jsonMode, readiness, decision.reason);

  const expectedBytes = canonicalProfileBytes(profile);
  const transitionId = randomUUID();
  profile.scope.enforce_runtime = true;
  const audit = await startBrokerEnforceAudit(cwd, readiness, force, {
    transitionId,
    fingerprint: profileFingerprint(profile),
    profileDigest: profileDigest(profile),
  });
  if (!audit.ok) return refuseEnforcement(jsonMode, audit.reason);

  // Prepare the signature before publishing the updated scope.
  const sig = await publishEnforceProfile(cwd, profile, expectedBytes, transitionId);
  if (!sig.ok) {
    await audit.recordOutcome("enforce-failed");
    return refuseEnforcement(
      jsonMode,
      `Could not sign and publish the enforcement profile. ${sig.error}`,
      false,
    );
  }
  const auditStatus = await audit.recordOutcome("enforce-enabled");
  return reportEnabled(jsonMode, sig, auditStatus, {
    reason: `Enforce enabled. ${decision.reason}`,
    forced: force,
  });
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
