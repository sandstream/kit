/**
 * Refuse to sign with an identity this machine has revoked (Pillar 1).
 *
 * `kit identity migrate` records a signed revocation of the old kit-managed file key and tells
 * the operator "revoked old file key … new ones use <hardware kid>". Before this guard, that
 * sentence was not true of anything kit did next: the revoked file key kept signing profiles,
 * policies, audit entries and shared-memory rows, and `kit doctor` said nothing. The revocation
 * existed as a record and changed no behaviour.
 *
 * WHY HERE AND NOT IN THE VERIFIER: `verifyProfileSignature` / `verifyPolicy` deliberately do NOT
 * treat the machine-local trust root as a revocation authority — otherwise anyone with write
 * access to one host could revoke an org signer and fail-close everyone's verification. That
 * decision is right, and it is also why the local revocation has to bite on the SIGNING side:
 * kit refusing to use its own revoked key is a statement about kit's own key, not an attempt to
 * make other verifiers distrust a third party.
 *
 * Fail-closed direction: the residual abuse is planting a revocation of the active kid to stop
 * kit signing (a local denial of service). That needs write access to the identity dir, which
 * already hands over the file private key outright — and refusing to sign is the safe side of
 * the failure.
 */
import { identityId, isRevoked } from "../identity.js";
import type { KeyStore } from "./types.js";

/** The active kid, or null when the backend has no key / cannot derive one. Never throws. */
function activeKid(store: Pick<KeyStore, "publicKeyPem">): string | null {
  try {
    const pub = store.publicKeyPem();
    return pub ? identityId(pub) : null;
  } catch {
    return null;
  }
}

/**
 * True when this machine holds an AUTHORITATIVE revocation of the store's own key. Uses the
 * LOCAL trust context (`isRevoked`): a self-revocation, or one signed by the machine's current
 * identity or its recorded external identity — the key that `kit identity migrate` signs with.
 */
export function storeKeyIsRevoked(store: Pick<KeyStore, "publicKeyPem">, dir?: string): boolean {
  const kid = activeKid(store);
  return kid !== null && isRevoked(kid, dir);
}

/**
 * Wrap a store so sign() refuses once its key is locally revoked. Everything else passes through
 * unchanged, so `kit identity show` / `doctor` can still READ a revoked identity and report it —
 * only producing NEW signatures with it is blocked.
 */
export function withRevocationRefusal(store: KeyStore, dir?: string): KeyStore {
  return {
    kind: store.kind,
    available: () => store.available(),
    publicKeyPem: () => store.publicKeyPem(),
    sign: (data) => {
      if (storeKeyIsRevoked(store, dir)) {
        const kid = activeKid(store);
        throw new Error(
          `refusing to sign: identity ${kid} is REVOKED on this machine (see revocations.jsonl). ` +
            "Signing with a revoked key would produce artifacts kit itself treats as untrusted. " +
            "Activate the successor key (KIT_KEYSTORE=command with KIT_KEYSTORE_SIGN_CMD + " +
            "KIT_KEYSTORE_PUBKEY), or run 'kit identity rotate' to mint a fresh one.",
        );
      }
      return store.sign(data);
    },
    create: (now) => store.create(now),
    rotate: (now) => store.rotate(now),
  };
}
