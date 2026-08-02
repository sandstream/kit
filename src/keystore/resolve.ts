/**
 * resolveKeyStore() — the honest KeyStore selector and the module's KIT_<X>
 * override (KIT_KEYSTORE), matching the env-override convention of the other
 * kit parsers.
 *
 * AUTO mode (no force): walk the preference order [secure-enclave, tpm, file]
 * and pick the FIRST backend whose available().ok is true. The hardware stubs
 * are unavailable today, so it lands on "file" with degraded=true and a reason
 * that QUOTES the skipped hardware backends' reasons plus the plain statement
 * that file is same-UID-readable and NOT hardware-rooted.
 *
 * FORCE mode (opts.force ?? parse(KIT_KEYSTORE)): select exactly that backend.
 *   - file          -> degraded=false.
 *   - hardware OK    -> degraded=false (would only happen once implemented).
 *   - hardware UNAVAILABLE -> return that (unavailable) store with degraded=true
 *     and a reason that REFUSES to silently downgrade to file (no false green).
 *     Its sign() then fails closed at call time.
 * Unknown KIT_KEYSTORE value -> reason names the bad value + the valid set,
 * then AUTO-resolves to the safe file default.
 *
 * Always populates considered[] (audit trail) and always sets reason when
 * degraded. No network, no model, deterministic; NEVER throws — fail-closed
 * happens at sign-time, not here.
 */
import type { KeyStore, KeyStoreKind, KeyStoreResolution } from "./types.js";
import { FileKeyStore } from "./file-store.js";
import { ExternalCommandKeyStore } from "./command-store.js";
import { SecureEnclaveKeyStore } from "./secure-enclave-store.js";
import { TpmKeyStore } from "./tpm-store.js";
import { withExternalTrustRecording } from "./trust-store.js";
import { withRevocationRefusal } from "./revoked-guard.js";

/** Preference order for AUTO mode: strongest (hardware) first, file last. The
 *  operator-fronted "command" backend is preferred when configured — it is the one
 *  real hardware-rooted option today; the native stubs are unavailable pending a
 *  binding, so AUTO falls through them to file. */
const PREFERENCE: KeyStoreKind[] = ["command", "secure-enclave", "tpm", "file"];
const VALID_KINDS: KeyStoreKind[] = ["file", "command", "secure-enclave", "tpm"];

/**
 * Construct a backend, with the two behaviours every signing path must have:
 *
 *   - non-file backends record the signer's PUBLIC key into the local trust store on a
 *     successful sign — otherwise kit cannot verify its own hardware-signed artifacts, and a
 *     revocation signed by the hardware key is never honored;
 *   - any backend refuses to sign with a key this machine has revoked, so `kit identity migrate`
 *     revoking the old file key actually stops that key being used.
 *
 * Wrapping here rather than at each of the six `store.sign(...)` call sites is deliberate: the
 * next call site added gets both properties for free.
 */
function makeStore(kind: KeyStoreKind, dir?: string): KeyStore {
  return withRevocationRefusal(withExternalTrustRecording(makeRawStore(kind, dir), dir), dir);
}

function makeRawStore(kind: KeyStoreKind, dir?: string): KeyStore {
  switch (kind) {
    case "file":
      return new FileKeyStore(dir);
    case "command":
      return new ExternalCommandKeyStore();
    case "secure-enclave":
      return new SecureEnclaveKeyStore();
    case "tpm":
      return new TpmKeyStore();
  }
}

function parseForce(value: string | undefined): KeyStoreKind | { invalid: string } | undefined {
  if (value === undefined) return undefined;
  const v = value.trim();
  if (v === "") return undefined;
  if ((VALID_KINDS as string[]).includes(v)) return v as KeyStoreKind;
  return { invalid: v };
}

/** AUTO: pick the first available backend by preference, honestly degrading to file. */
function resolveAuto(dir: string | undefined, preludeReason?: string): KeyStoreResolution {
  const considered: KeyStoreResolution["considered"] = [];
  const skippedReasons: string[] = [];

  for (const kind of PREFERENCE) {
    const store = makeStore(kind, dir);
    const availability = store.available();
    considered.push({ kind, availability });
    if (availability.ok) {
      const degraded = kind !== PREFERENCE[0] || preludeReason !== undefined;
      let reason: string | undefined;
      if (degraded) {
        const parts: string[] = [];
        if (preludeReason) parts.push(preludeReason);
        if (kind === "file") {
          parts.push(
            "using the file backend: hardware-rooted backends are unavailable in this environment" +
              (skippedReasons.length ? ` (${skippedReasons.join("; ")})` : "") +
              ". The file backend stores the private key as a 0600 file under ~/.kit — it is SAME-UID readable and NOT hardware-rooted; only a real Secure Enclave/TPM backend closes the same-UID key-theft gap.",
          );
        }
        reason = parts.join(" ");
      }
      return { store, availability, degraded, reason, considered };
    }
    if (availability.reason) skippedReasons.push(availability.reason);
  }

  // Unreachable in practice: FileKeyStore.available() is always ok. Fail closed.
  const store = makeStore("file", dir);
  return {
    store,
    availability: store.available(),
    degraded: true,
    reason:
      "no available keystore backend was found; falling back to the file backend" +
      (preludeReason ? ` (${preludeReason})` : ""),
    considered,
  };
}

export function resolveKeyStore(opts?: { dir?: string; force?: KeyStoreKind }): KeyStoreResolution {
  const dir = opts?.dir;
  const forced = opts?.force ?? parseForce(process.env.KIT_KEYSTORE);

  // Unknown KIT_KEYSTORE value: name the bad value + valid set, then AUTO to safe file default.
  if (forced && typeof forced === "object") {
    return resolveAuto(
      dir,
      `ignoring invalid KIT_KEYSTORE="${forced.invalid}" (valid: ${VALID_KINDS.join(", ")});`,
    );
  }

  // No force -> AUTO.
  if (forced === undefined) return resolveAuto(dir);

  // FORCE mode: select exactly that backend.
  const store = makeStore(forced, dir);
  const availability = store.available();
  const considered: KeyStoreResolution["considered"] = [{ kind: forced, availability }];

  if (availability.ok) {
    // A forced, available backend is the strongest the operator asked for: not degraded.
    return { store, availability, degraded: false, considered };
  }

  // Forced but UNAVAILABLE (a hardware stub today): REFUSE to silently downgrade.
  return {
    store,
    availability,
    degraded: true,
    reason:
      `KIT_KEYSTORE forced the "${forced}" backend, which is unavailable here` +
      (availability.reason ? ` (${availability.reason})` : "") +
      ". Refusing to silently downgrade to the file backend (no false green); sign() will fail closed until this backend is available.",
    considered,
  };
}
