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
  existsSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  mkdtempSync,
  rmSync,
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
  | PolicyVerifyStatus;

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
  const stage = mkdtempSync(join(tmpdir(), "kit-policy-pull-"));
  try {
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

    // Verified → apply. Write ONLY the policy + its signature; never the trust anchor.
    writeFileSync(getPolicyPath(destRoot), readFileSync(srcPolicy));
    writeFileSync(getPolicySigPath(destRoot), readFileSync(srcSig));
    return {
      ok: true,
      status: "applied",
      detail: `applied org policy — ${v.detail}`,
      fingerprint: v.fingerprint,
    };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
