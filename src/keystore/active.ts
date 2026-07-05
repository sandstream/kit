/**
 * The active-keystore facade: resolve the backend, ENFORCE a hardware requirement when
 * one is in force, and sign through it. This is the seam that turns the KeyStore port
 * from an unused abstraction into kit's real signing path.
 *
 * Enforcement is the half that makes hardware-root meaningful: without it, a
 * hardware-required org could still silently sign with the same-UID-readable file key
 * (a false green). `assertHardwareIdentity` fails CLOSED — it refuses to sign, with the
 * honest degradation reason — whenever hardware is required but the resolved backend
 * isn't hardware-rooted.
 *
 * The requirement can come from the environment (KIT_REQUIRE_HARDWARE_IDENTITY) or be
 * passed in by a caller that read it from `.kit-policy` / config (so policy can mandate
 * it fleet-wide). Deterministic, offline, never network.
 */
import { identityId } from "../identity.js";
import { resolveKeyStore } from "./resolve.js";
import { hardwareRequiredByEnv } from "./mandate.js";
import type { KeyStoreResolution } from "./types.js";

export { hardwareRequiredByEnv } from "./mandate.js";

/**
 * Is the resolved backend genuinely hardware-rooted — i.e. the private key is NOT a
 * same-UID-readable file? True only for a non-file backend that is available and not
 * degraded. The file backend is never hardware-rooted; an unavailable/degraded forced
 * hardware backend is not either (it is failing closed, not protecting a key).
 */
export function isHardwareRooted(res: KeyStoreResolution): boolean {
  return res.store.kind !== "file" && res.availability.ok && !res.degraded;
}

/**
 * Fail closed if a hardware-rooted identity is required but the resolved keystore isn't
 * one. `required` defaults to the env mandate; a caller that also honors a policy/config
 * flag should pass `envRequired || policyRequired`. Throws with the honest reason so the
 * operator knows exactly why and how to fix it. No-op when not required.
 */
export function assertHardwareIdentity(
  res: KeyStoreResolution,
  required: boolean = hardwareRequiredByEnv(),
): void {
  if (!required || isHardwareRooted(res)) return;
  throw new Error(
    "hardware-rooted identity is REQUIRED but the active keystore is not hardware-rooted: " +
      (res.reason ??
        `the "${res.store.kind}" backend does not protect the key from same-UID theft`) +
      ". Configure a hardware backend — KIT_KEYSTORE=command with KIT_KEYSTORE_SIGN_CMD + " +
      "KIT_KEYSTORE_PUBKEY (TPM/HSM/enclave/YubiKey), or a Secure Enclave/TPM binding.",
  );
}

/**
 * Resolve + enforce + sign. The single high-level signing entry point callers should
 * use instead of reaching for the file primitive directly, so a hardware mandate is
 * honored everywhere. `required` lets a caller fold in a policy/config mandate on top of
 * the env one. Fail-closed: throws if the requirement isn't met or the backend can't sign.
 */
export function keystoreSign(
  data: Buffer | string,
  opts: { dir?: string; required?: boolean } = {},
): Buffer {
  const res = resolveKeyStore({ dir: opts.dir });
  assertHardwareIdentity(res, opts.required ?? hardwareRequiredByEnv());
  return res.store.sign(data);
}

export interface KeyStoreStatus {
  kind: KeyStoreResolution["store"]["kind"];
  hardwareRooted: boolean;
  available: boolean;
  degraded: boolean;
  reason?: string;
  /** kid of the active identity, when the backend can surface a public key. */
  kid: string | null;
}

/** A compact, honest status summary for surfacing in `kit identity` / statusline. */
export function activeKeyStoreStatus(dir?: string): KeyStoreStatus {
  const res = resolveKeyStore({ dir });
  let kid: string | null = null;
  try {
    const pub = res.store.publicKeyPem();
    if (pub) kid = identityId(pub); // pure; derives the kid, never touches the private key
  } catch {
    kid = null;
  }
  return {
    kind: res.store.kind,
    hardwareRooted: isHardwareRooted(res),
    available: res.availability.ok,
    degraded: res.degraded,
    reason: res.reason,
    kid,
  };
}
