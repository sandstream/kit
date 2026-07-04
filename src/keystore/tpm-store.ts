/**
 * TpmKeyStore — the linux/win extension-point STUB for the KeyStore port.
 *
 * Mirror of the Secure Enclave stub, for a TPM 2.0 device (via a PKCS#11 / tpm2
 * binding). TODAY it is an HONEST stub: in EVERY environment available() returns
 * { ok:false, reason } — off-platform the reason names the requirement,
 * on-platform it states the implementation is not yet wired. It NEVER reports
 * ok:true here (no false green). sign()/create()/rotate() FAIL CLOSED (throw the
 * availability reason); publicKeyPem() returns null.
 *
 * Zero-dep discipline: node builtins only. A real pkcs11/tpm2 binding is added
 * ONLY alongside a working implementation (behind triage), never speculatively —
 * preserving kit's offline, zero-dep posture.
 */
import type { Identity } from "../identity.js";
import type { KeyStore, KeyStoreAvailability } from "./types.js";

export class TpmKeyStore implements KeyStore {
  readonly kind = "tpm" as const;

  available(): KeyStoreAvailability {
    if (process.platform !== "linux" && process.platform !== "win32") {
      return {
        ok: false,
        reason: `tpm requires Linux or Windows with a TPM 2.0 device; current platform is ${process.platform}`,
      };
    }
    return {
      ok: false,
      reason: "tpm requires a TPM 2.0 device and a PKCS#11 / tpm2 binding (not yet implemented)",
    };
  }

  publicKeyPem(): string | null {
    return null;
  }

  sign(_data: Buffer | string): Buffer {
    throw new Error(this.available().reason);
  }

  create(_now?: string): { identity: Identity; created: boolean } {
    throw new Error(this.available().reason);
  }

  rotate(_now?: string): { identity: Identity; previousId: string | null } {
    throw new Error(this.available().reason);
  }
}
