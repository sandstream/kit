/**
 * FileKeyStore — the working default backend for the KeyStore port.
 *
 * PURE DELEGATION to ../identity.js: it never re-implements crypto, key
 * generation, or file permissions — it wraps signWithIdentity /
 * loadOrCreateIdentity / rotateIdentity / tryLoadIdentity and threads the
 * existing KIT_IDENTITY_DIR override (via the optional constructor `dir`)
 * straight through. Rewriting any of that here would fork the trust code; the
 * whole point of Pelare 1 is that this backend is a thin adapter over the
 * primitive kit already ships.
 *
 * HONEST THREAT BOUNDARY: this backend stores the private key as a 0600 file
 * under ~/.kit, so a SAME-UID local principal can read it and sign as this
 * identity — exactly the boundary ../identity.js documents. It is NOT
 * hardware-rooted; only a real Secure Enclave / TPM backend closes the
 * same-UID key-theft gap. resolveKeyStore() surfaces this in its degradation
 * reason so operators are never misled.
 */
import type { Identity } from "../identity.js";
import {
  signWithIdentity,
  loadOrCreateIdentity,
  rotateIdentity,
  tryLoadIdentity,
} from "../identity.js";
import type { KeyStore, KeyStoreAvailability } from "./types.js";

export class FileKeyStore implements KeyStore {
  readonly kind = "file" as const;
  /** Optional identity dir; threads through ../identity.js (KIT_IDENTITY_DIR). */
  private readonly dir?: string;

  constructor(dir?: string) {
    this.dir = dir;
  }

  /** The file backend can always operate — the filesystem is the requirement. */
  available(): KeyStoreAvailability {
    return { ok: true };
  }

  publicKeyPem(): string | null {
    return tryLoadIdentity(this.dir)?.publicKey ?? null;
  }

  sign(data: Buffer | string): Buffer {
    return signWithIdentity(data, this.dir);
  }

  create(now?: string): { identity: Identity; created: boolean } {
    return loadOrCreateIdentity(this.dir, now);
  }

  rotate(now?: string): { identity: Identity; previousId: string | null } {
    return rotateIdentity(this.dir, now);
  }
}
