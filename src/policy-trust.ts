/**
 * kit policy trust anchor — org-distributed policy verification (3.0 Phase 2 starter).
 *
 * Phase 1 signs a policy with the LOCAL identity, so `verifyPolicy` could only
 * resolve the signer via this machine's own keys (or a per-invocation `--key`).
 * That can't express the org case: ONE policy signed by a central org key,
 * dropped into MANY repos, verified everywhere. This adds a committed,
 * repo-resident trust anchor — `.kit-policy.signers` — listing the org public
 * key(s) allowed to sign the policy. `verifyPolicy` consults it after the local
 * store, so a distributed org-signed policy verifies authentically on any clone,
 * with no shared secret (asymmetric: only public keys are distributed).
 *
 * Committed + reviewed like the rest of the governance surface; deterministic,
 * zero-LLM. Once an anchor is present, an un-anchored signer is fail-CLOSED in the
 * gate (see policy-check.ts) — the same "fail-closed once anchored" discipline as
 * the HMAC audit anchor.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { identityId } from "./identity.js";

export const POLICY_SIGNERS_FILE = ".kit-policy.signers";

export interface PolicySigner {
  /** kid derived from the public key (stable, non-secret). */
  id: string;
  /** SPKI PEM — the org public key allowed to sign the policy. */
  publicKey: string;
  /** Human label (e.g. "acme-security"). */
  label?: string;
}

export function getSignersPath(root: string): string {
  return join(root, POLICY_SIGNERS_FILE);
}

/** Read the committed trust anchor. Best-effort: [] when absent/malformed. */
export function loadPolicySigners(root: string): PolicySigner[] {
  try {
    const raw = JSON.parse(readFileSync(getSignersPath(root), "utf-8")) as {
      signers?: unknown;
    };
    if (!raw || !Array.isArray(raw.signers)) return [];
    return raw.signers.filter(
      (s): s is PolicySigner =>
        !!s &&
        typeof (s as PolicySigner).id === "string" &&
        typeof (s as PolicySigner).publicKey === "string",
    );
  } catch {
    return [];
  }
}

/** kid → public-key (PEM) map of the org-trusted policy signers. */
export function policySignersMap(root: string): Map<string, string> {
  return new Map(loadPolicySigners(root).map((s) => [s.id, s.publicKey]));
}

/** True when a non-empty trust anchor is present (⇒ gate is fail-closed on an untrusted signer). */
export function hasPolicyAnchor(root: string): boolean {
  return loadPolicySigners(root).length > 0;
}

export interface AddSignerResult {
  added: boolean;
  signer: PolicySigner;
  reason?: string;
}

/**
 * Add an org public key (SPKI PEM) to the trust anchor. Idempotent on the derived
 * id. Throws if the PEM is not a valid public key. Writes pretty JSON (diffable).
 */
export function addPolicySigner(
  root: string,
  publicKeyPem: string,
  label?: string,
): AddSignerResult {
  const id = identityId(publicKeyPem); // throws on a malformed key — fail loud
  const signers = loadPolicySigners(root);
  const existing = signers.find((s) => s.id === id);
  if (existing) return { added: false, signer: existing, reason: "already trusted" };
  const signer: PolicySigner = { id, publicKey: publicKeyPem, ...(label ? { label } : {}) };
  signers.push(signer);
  writeFileSync(getSignersPath(root), JSON.stringify({ signers }, null, 2) + "\n", "utf-8");
  return { added: true, signer };
}

/** Remove a signer by id. Returns true if one was removed. */
export function removePolicySigner(root: string, id: string): boolean {
  const signers = loadPolicySigners(root);
  const next = signers.filter((s) => s.id !== id);
  if (next.length === signers.length) return false;
  writeFileSync(getSignersPath(root), JSON.stringify({ signers: next }, null, 2) + "\n", "utf-8");
  return true;
}
