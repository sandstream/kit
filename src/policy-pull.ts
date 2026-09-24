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
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  POLICY_FILE,
  POLICY_SIG_FILE,
  getPolicyPath,
  getPolicySigPath,
  loadPolicy,
  verifyPolicy,
  type PolicyVerifyStatus,
} from "./policy-doc.js";
import { POLICY_SIGNERS_FILE, getSignersPath, hasPolicyAnchor } from "./policy-trust.js";

export type PullStatus =
  /** Verified against the local anchor and written to the project. */
  | "applied"
  /** The source has no `.kit-policy.toml` + `.kit-policy.sig` pair. */
  | "no-source"
  /** No local `.kit-policy.signers` anchor — root trust is never fetched (§6.1), so fail closed. */
  | "no-anchor"
  /** Verification did not return "valid"; the policy was NOT applied (kept existing). */
  | PolicyVerifyStatus
  /**
   * The pulled policy verified, but its `revision` would move the applied ratchet BACKWARD
   * (lower, or absent while a revision is applied). Refused; the existing pair is kept.
   * This is what stops a replay of an older, still-validly-signed policy from restoring a
   * permission the org has since removed.
   */
  | "stale-revision"
  /** Installation or lock handling failed; the destination must be verified before use. */
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

export function readRegularSource(path: string): Buffer | null {
  // O_NONBLOCK prevents a FIFO substituted at this path from waiting for a writer.
  // Inspect and read through the same descriptor so a path swap cannot undo the check.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) return null;
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

type RenameFile = (from: string, to: string) => void;

export interface ApplyPolicyPairResult {
  ok: boolean;
  detail: string;
}

type SignatureSnapshot =
  | { kind: "file"; bytes: Buffer; mode: number }
  | { kind: "symlink"; target: string };

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return "filesystem error";
}

function readSignatureSnapshot(path: string): SignatureSnapshot | null {
  let info;
  try {
    info = lstatSync(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
  if (info.isSymbolicLink()) {
    const target = readlinkSync(path);
    const after = lstatSync(path);
    if (!after.isSymbolicLink() || after.dev !== info.dev || after.ino !== info.ino) {
      throw Object.assign(new Error("signature changed during snapshot"), { code: "EAGAIN" });
    }
    return { kind: "symlink", target };
  }
  if (!info.isFile())
    throw Object.assign(new Error("signature is not a regular file"), { code: "EINVAL" });
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) {
      throw Object.assign(new Error("signature changed during snapshot"), { code: "EAGAIN" });
    }
    return { kind: "file", bytes: readFileSync(fd), mode: opened.mode };
  } finally {
    closeSync(fd);
  }
}

function restoreSignature(path: string, snapshot: SignatureSnapshot | null): void {
  if (snapshot === null) {
    rmSync(path, { force: true });
    return;
  }
  const stage = mkdtempSync(join(dirname(path), ".kit-policy-restore-"));
  try {
    const replacement = join(stage, "signature");
    if (snapshot.kind === "symlink") {
      symlinkSync(snapshot.target, replacement);
    } else {
      writeFileSync(replacement, snapshot.bytes, { mode: snapshot.mode });
      chmodSync(replacement, snapshot.mode);
    }
    renameSync(replacement, path);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
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
 * The one-way revision ratchet PolicyDoc.revision has always documented and nothing
 * enforced (PP-02). Returns the refusal reason, or null when the pull may proceed.
 *
 * Read from the APPLIED policy on disk and from the VERIFIED staged copy, never from the
 * source: the incoming revision is only a claim worth acting on once its signature has
 * been checked. Opt-in and one-way: no applied revision means no ratchet yet (a fleet that
 * has never published one is unaffected), and an equal revision is a re-apply, not a
 * rollback. An absent incoming revision IS refused once one is applied, because "drop the
 * revision key" would otherwise be the trivial way around the ratchet.
 */
function staleRevisionRefusal(destRoot: string, stage: string): string | null {
  const applied = loadPolicy(destRoot)?.revision;
  if (typeof applied !== "number") return null;

  const incoming = loadPolicy(stage)?.revision;
  if (typeof incoming !== "number") {
    return `pulled policy declares no revision while revision ${applied} is applied: refusing a bundle that would drop rollback protection`;
  }
  if (incoming < applied) {
    return `pulled policy revision ${incoming} is older than the applied revision ${applied}: refusing a rollback`;
  }
  return null;
}

export interface PullPolicyDeps {
  /**
   * Called under the destination lock once verification and the revision check have
   * succeeded, before the pair is installed. The ONLY purpose is to make the
   * verify-to-install window observable to a test, so the
   * "installs what it verified" invariant (PP-01) can be asserted deterministically
   * instead of raced. Same injected-seam precedent as `applyPolicyPairAtomically`'s
   * `renameFile`. Production callers never pass it.
   */
  afterVerify?: () => void;
}

function withPolicyPullLock(destRoot: string, install: () => PullResult): PullResult {
  const lock = join(destRoot, ".kit-policy-pull.lock");
  try {
    // Atomic creation serializes all pulls into this destination, including path aliases.
    // Never break an existing lock: age or a missing PID cannot prove its owner is done.
    mkdirSync(lock, { mode: 0o700 });
  } catch (error) {
    const reason = errorCode(error) === "EEXIST" ? "busy" : `unavailable (${errorCode(error)})`;
    return {
      ok: false,
      status: "apply-failed",
      detail: `policy pull lock is ${reason}; verified policy NOT applied (kept existing); existing locks are never removed automatically`,
    };
  }
  try {
    return install();
  } finally {
    // Only remove the empty lock we acquired; cleanup errors leave subsequent pulls closed.
    rmdirSync(lock);
  }
}

/**
 * Decide and install, given a stage whose pair verifyPolicy has already accepted.
 * Split out of `pullPolicy` to keep both halves inside the repo's function-length gate:
 * this half owns the ratchet and the write, that half owns fetch, staging and verify.
 */
function installVerifiedPull(
  destRoot: string,
  stage: string,
  verifyDetail: string,
  fingerprint: string | undefined,
  deps: PullPolicyDeps,
): PullResult {
  return withPolicyPullLock(destRoot, () => {
    // Compare and install under the same lock so a concurrent pull cannot undo the ratchet.
    const stale = staleRevisionRefusal(destRoot, stage);
    if (stale !== null) {
      return {
        ok: false,
        status: "stale-revision",
        detail: `${stale} (kept existing)`,
        fingerprint,
      };
    }

    deps.afterVerify?.();

    // Install the STAGED bytes: the ones verifyPolicy just accepted. Re-reading the source
    // here reopened the whole verification window (PP-01). A source that changed after
    // verification (a shared mount, a git checkout, an attacker with write access to the
    // distribution dir) had its unverified bytes installed under a "verified" verdict.
    // Never write or fetch the trust anchor.
    const applied = applyPolicyPairAtomically(
      destRoot,
      readFileSync(join(stage, POLICY_FILE)),
      readFileSync(join(stage, POLICY_SIG_FILE)),
    );
    if (!applied.ok) {
      return {
        ok: false,
        status: "apply-failed",
        detail: `verified policy NOT applied: ${applied.detail}`,
        fingerprint,
      };
    }
    return {
      ok: true,
      status: "applied",
      detail: `applied org policy: ${verifyDetail}`,
      fingerprint,
    };
  });
}

/**
 * Pull the signed policy at `source` into `destRoot`, applying it only if it verifies against
 * `destRoot`'s LOCAL trust anchor. Never throws; never writes `.kit-policy.signers`.
 */
export function pullPolicy(
  source: string,
  destRoot: string,
  deps: PullPolicyDeps = {},
): PullResult {
  const srcDir = pullSourceToPath(source);
  const srcPolicy = join(srcDir, POLICY_FILE);
  const srcSig = join(srcDir, POLICY_SIG_FILE);
  if (!existsSync(srcPolicy) || !existsSync(srcSig)) {
    return {
      ok: false,
      status: "no-source",
      detail: `no signed policy at the configured source — expected ${POLICY_FILE} + ${POLICY_SIG_FILE}`,
    };
  }

  // §6.1 — the anchor is NEVER pulled; it must exist locally, committed out of band.
  if (!hasPolicyAnchor(destRoot)) {
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
    const policyBytes = readRegularSource(srcPolicy);
    const signatureBytes = readRegularSource(srcSig);
    if (policyBytes === null || signatureBytes === null) {
      return {
        ok: false,
        status: "no-source",
        detail:
          "policy source must contain a regular file for both policy and signature; kept existing",
      };
    }
    writeFileSync(join(stage, POLICY_FILE), policyBytes);
    writeFileSync(join(stage, POLICY_SIG_FILE), signatureBytes);
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

    return installVerifiedPull(destRoot, stage, v.detail, v.fingerprint, deps);
  } catch (error) {
    return {
      ok: false,
      status: "apply-failed",
      detail: `policy pull could not complete (${errorCode(error)}); inspect the destination policy and pull lock before retrying`,
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
