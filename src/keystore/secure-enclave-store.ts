/**
 * SecureEnclaveKeyStore — the darwin extension-point STUB for the KeyStore port.
 *
 * This is where a real, non-exportable Apple Secure Enclave key (via a native
 * Keychain/SecKey binding) will land. TODAY it is an HONEST stub: in EVERY
 * environment available() returns { ok:false, reason } — off-darwin the reason
 * names the platform requirement, on-darwin it states the implementation is not
 * yet wired. It NEVER reports ok:true here — that would be a false green, which
 * kit forbids. sign()/create()/rotate() FAIL CLOSED (throw the availability
 * reason); publicKeyPem() returns null.
 *
 * Zero-dep discipline: node builtins only. The real SecKey/Keychain binding is
 * introduced ONLY alongside a working implementation (behind triage), never as a
 * speculative dependency — that keeps the offline, zero-dep posture intact.
 */
import type { Identity } from "../identity.js";
import type { KeyStore, KeyStoreAvailability } from "./types.js";

export class SecureEnclaveKeyStore implements KeyStore {
  readonly kind = "secure-enclave" as const;

  available(): KeyStoreAvailability {
    if (process.platform !== "darwin") {
      return {
        ok: false,
        reason: `secure-enclave requires macOS (darwin); current platform is ${process.platform}`,
      };
    }
    return {
      ok: false,
      reason:
        "secure-enclave requires a native Keychain/SecKey binding to the Apple Secure Enclave (not yet implemented)",
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
