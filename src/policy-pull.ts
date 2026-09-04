/**
 * kit control plane (Pillar 2) — `kit policy pull`: fetch an org-signed policy from a self-hostable
 * source and APPLY it only if it verifies OFFLINE against the LOCAL trust anchor.
 *
 * This is a "dumb pipe, smart verifier": the source ships bytes (`.kit-policy.toml` + `.kit-policy.sig`);
 * kit verifies them with the existing `verifyPolicy` before anything is written. Deliberately
 * SMALL and safe:
 *
 *   - **No root-trust-from-the-network:** the trust anchor `.kit-policy.signers` is NEVER
 *     pulled. It must already exist LOCALLY (committed / bootstrapped out of band). A pull with no
 *     local anchor fails closed — a pulled policy that only this machine could verify is not "org
 *     distribution", and letting the fetch carry the root of trust would make the chain only as
 *     strong as the fetch.
 *   - **Verify-before-write, fail-closed:** the pulled policy+sig are staged in a temp dir WITH the
 *     LOCAL anchor and run through `verifyPolicy`; only `status === "valid"` writes to the project.
 *     Anything else keeps the existing policy untouched. Revocations are still consulted (they come
 *     from the identity store, not the staged dir), so a revoked org signer is rejected.
 *   - **`file://` / local path source only:** no new network client in the MVP; a git remote
 *     is a follow-up. Air-gap stays green because pull is manual and never runs during verification.
 *
 * Deterministic, local-only, no telemetry, no egress.
 */
import {
  chmodSync,
  existsSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  POLICY_FILE,
  POLICY_SIG_FILE,
  getPolicyPath,
  getPolicySigPath,
  verifyPolicy,
  type PolicyVerifyStatus,
} from "./policy-doc.js";
import { POLICY_SIGNERS_FILE, getSignersPath } from "./policy-trust.js";

export type PullStatus =
  /** Verified against the local anchor and written to the project. */
  | "applied"
  /** The source has no `.kit-policy.toml` + `.kit-policy.sig` pair. */
  | "no-source"
  /** No local `.kit-policy.signers` anchor — root trust is never fetched (§6.1), so fail closed. */
  | "no-anchor"
  /** Verification did not return "valid"; the policy was NOT applied (kept existing). */
  | PolicyVerifyStatus
  /** The verified pair could not be installed; the prior pair was retained or remains fail-closed. */
  | "apply-failed";

export interface PullResult {
  ok: boolean;
  status: PullStatus;
  detail: string;
  fingerprint?: string;
}

/** Strip a leading `file://` and resolve to an absolute filesystem path. */
export function pullSourceToPath(source: string): string {
  const s = source.startsWith("file://") ? source.slice("file://".length) : source;
  return resolve(s);
}

type RenameFile = (from: string, to: string) => void;

export interface ApplyPolicyPairResult {
  ok: boolean;
  detail: string;
}

interface SignatureSnapshot {
  bytes: Buffer;
  mode: number;
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return "filesystem error";
}

function readSignatureSnapshot(path: string): SignatureSnapshot | null {
  if (!existsSync(path)) return null;
  return {
    bytes: readFileSync(path),
    mode: statSync(path).mode,
  };
}

function restoreSignature(path: string, snapshot: SignatureSnapshot | null): void {
  if (snapshot === null) {
    rmSync(path, { force: true });
    return;
  }
  writeFileSync(path, snapshot.bytes);
  chmodSync(path, snapshot.mode);
}

function rollbackSignature(
  path: string,
  snapshot: SignatureSnapshot | null,
  applyError: unknown,
): ApplyPolicyPairResult {
  try {
    restoreSignature(path, snapshot);
  } catch (restoreError) {
    return {
      ok: false,
      detail: `apply failed (${errorCode(applyError)}); signature rollback also failed (${errorCode(restoreError)}) — policy remains fail-closed`,
    };
  }
  return {
    ok: false,
    detail: `apply failed (${errorCode(applyError)}); previous pair retained`,
  };
}

/**
 * Install a verified policy pair without ever exposing a new policy under an old signature.
 * The signature moves first, making any interrupted transition fail closed; the policy is the
 * final atomic rename. If that rename fails, restore the exact previous signature bytes.
 */
export function applyPolicyPairAtomically(
  destRoot: string,
  policyBytes: Buffer,
  signatureBytes: Buffer,
  renameFile: RenameFile = renameSync,
): ApplyPolicyPairResult {
  let stage: string | null = null;
  const destPolicy = getPolicyPath(destRoot);
  const destSignature = getPolicySigPath(destRoot);
  let previousSignature: SignatureSnapshot | null = null;
  let signatureReplaced = false;

  try {
    previousSignature = readSignatureSnapshot(destSignature);
    stage = mkdtempSync(join(destRoot, ".kit-policy-apply-"));
    const nextPolicy = join(stage, POLICY_FILE);
    const nextSignature = join(stage, POLICY_SIG_FILE);
    writeFileSync(nextPolicy, policyBytes);
    writeFileSync(nextSignature, signatureBytes);

    renameFile(nextSignature, destSignature);
    signatureReplaced = true;
    renameFile(nextPolicy, destPolicy);
    return { ok: true, detail: "verified policy pair installed" };
  } catch (error) {
    if (signatureReplaced) {
      return rollbackSignature(destSignature, previousSignature, error);
    }
    return { ok: false, detail: `apply failed (${errorCode(error)}); previous pair retained` };
  } finally {
    if (stage) {
      try {
        rmSync(stage, { recursive: true, force: true });
      } catch {
        // The applied pair is already complete; stale private staging data is non-authoritative.
      }
    }
  }
}

/**
 * Pull the signed policy at `source` into `destRoot`, applying it only if it verifies against
 * `destRoot`'s LOCAL trust anchor. Never throws; never writes `.kit-policy.signers`.
 */
export function pullPolicy(source: string, destRoot: string): PullResult {
  const srcDir = pullSourceToPath(source);
  const srcPolicy = join(srcDir, POLICY_FILE);
  const srcSig = join(srcDir, POLICY_SIG_FILE);
  if (!existsSync(srcPolicy) || !existsSync(srcSig)) {
    return {
      ok: false,
      status: "no-source",
      detail: `no signed policy at ${srcDir} — expected ${POLICY_FILE} + ${POLICY_SIG_FILE}`,
    };
  }

  // §6.1 — the anchor is NEVER pulled; it must exist locally, committed out of band.
  if (!existsSync(getSignersPath(destRoot))) {
    return {
      ok: false,
      status: "no-anchor",
      detail: `no local ${POLICY_SIGNERS_FILE} trust anchor — commit the org anchor out of band before pulling (root trust is never fetched)`,
    };
  }

  // Stage pulled policy+sig WITH the LOCAL anchor and verify OFFLINE before writing anything.
  let stage: string | null = null;
  try {
    stage = mkdtempSync(join(tmpdir(), "kit-policy-pull-"));
    copyFileSync(srcPolicy, join(stage, POLICY_FILE));
    copyFileSync(srcSig, join(stage, POLICY_SIG_FILE));
    // The LOCAL anchor — deliberately not the source's — is what the pulled policy must satisfy.
    copyFileSync(getSignersPath(destRoot), join(stage, POLICY_SIGNERS_FILE));

    const v = verifyPolicy(stage);
    if (v.status !== "valid") {
      return {
        ok: false,
        status: v.status,
        detail: `pulled policy NOT applied — ${v.detail} (fail-closed; kept existing)`,
        fingerprint: v.fingerprint,
      };
    }

    // Verified → install the pair fail-closed; never write or fetch the trust anchor.
    const applied = applyPolicyPairAtomically(
      destRoot,
      readFileSync(srcPolicy),
      readFileSync(srcSig),
    );
    if (!applied.ok) {
      return {
        ok: false,
        status: "apply-failed",
        detail: `verified policy NOT applied — ${applied.detail}`,
        fingerprint: v.fingerprint,
      };
    }
    return {
      ok: true,
      status: "applied",
      detail: `applied org policy — ${v.detail}`,
      fingerprint: v.fingerprint,
    };
  } catch (error) {
    return {
      ok: false,
      status: "apply-failed",
      detail: `policy pull could not complete (${errorCode(error)}); existing policy was not intentionally changed`,
    };
  } finally {
    if (stage) {
      try {
        rmSync(stage, { recursive: true, force: true });
      } catch {
        // Staging is non-authoritative; cleanup failure cannot invalidate the applied pair.
      }
    }
  }
}
