/**
 * ExternalCommandKeyStore — the FIRST real hardware-rooted backend for the KeyStore
 * port, and the one that closes the same-UID key-theft gap TODAY without kit shipping
 * any native code.
 *
 * The private key lives in whatever hardware the operator fronts — a TPM 2.0 object,
 * a PKCS#11/YubiKey slot, an ssh-agent-held resident key, an Apple Secure Enclave
 * helper — and NEVER enters kit's process or disk. kit holds only the PUBLIC key and
 * shells out to an operator-supplied command to produce each signature. A same-UID
 * attacker who can read ~/.kit finds no private key to steal: there is no key file.
 * (Whether they can *use* the key while the machine is unlocked is the operator's
 * command's concern — a good command requires touch/PIN/presence for each sign.)
 *
 * This mirrors commandExternalAnchor in audit-anchor.ts: kit ships NO network/native
 * client (that would break the local-first, zero-dep, offline posture); the operator
 * wires the transport. FAIL-CLOSED throughout: a missing config, a non-zero exit,
 * empty/garbled output, or a signature that does not verify against the advertised
 * public key all THROW — kit never emits an unverifiable signature and never silently
 * downgrades. Node builtins only.
 *
 * Config (env, matching kit's KIT_<X> convention):
 *   KIT_KEYSTORE_SIGN_CMD  — command that reads the bytes-to-sign on STDIN and prints
 *                            the Ed25519 signature (base64) on STDOUT. Non-zero exit =
 *                            failure. The private key is used INSIDE this command only.
 *   KIT_KEYSTORE_PUBKEY    — the SPKI PEM public key: an inline PEM (contains
 *                            "BEGIN PUBLIC KEY"), or a path to a .pem file.
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { Identity } from "../identity.js";
import { identityId, verifySignature } from "../identity.js";
import type { KeyStore, KeyStoreAvailability } from "./types.js";

const SIGN_CMD_ENV = "KIT_KEYSTORE_SIGN_CMD";
const PUBKEY_ENV = "KIT_KEYSTORE_PUBKEY";

function readSignCmd(): string {
  return (process.env[SIGN_CMD_ENV] ?? "").trim();
}

/** Resolve the configured public key PEM (inline or @file), or null when unset/unreadable. */
function readPubkeyPem(): string | null {
  const raw = (process.env[PUBKEY_ENV] ?? "").trim();
  if (!raw) return null;
  if (raw.includes("BEGIN PUBLIC KEY")) return raw;
  try {
    const pem = readFileSync(raw, "utf-8");
    return pem.includes("BEGIN PUBLIC KEY") ? pem : null;
  } catch {
    return null;
  }
}

export class ExternalCommandKeyStore implements KeyStore {
  readonly kind = "command" as const;

  /**
   * Available only when BOTH a sign command and a valid public key are configured —
   * kit must hold the public key to self-verify every signature and to attribute
   * entries. Honest reason otherwise; never faked.
   */
  available(): KeyStoreAvailability {
    if (!readSignCmd()) {
      return {
        ok: false,
        reason: `command keystore requires ${SIGN_CMD_ENV} (a command that signs STDIN with the hardware-held key)`,
      };
    }
    const pub = readPubkeyPem();
    if (!pub) {
      return {
        ok: false,
        reason: `command keystore requires ${PUBKEY_ENV} (the SPKI PEM public key, inline or a file path)`,
      };
    }
    try {
      identityId(pub); // reject a malformed PEM up front
    } catch {
      return { ok: false, reason: `${PUBKEY_ENV} is not a valid SPKI public key PEM` };
    }
    return { ok: true };
  }

  publicKeyPem(): string | null {
    return this.available().ok ? readPubkeyPem() : null;
  }

  /**
   * Sign via the operator's command (bytes on STDIN, base64 signature on STDOUT), then
   * SELF-VERIFY the returned signature against the advertised public key before handing
   * it back. The self-verify is the linchpin: it guarantees kit never emits a bad
   * signature and that the command's private key actually matches KIT_KEYSTORE_PUBKEY —
   * so a misconfigured or compromised command fails closed instead of producing a
   * silently-wrong attribution.
   */
  sign(data: Buffer | string): Buffer {
    const avail = this.available();
    if (!avail.ok) throw new Error(avail.reason);
    const cmd = readSignCmd();
    const input = Buffer.isBuffer(data) ? data : Buffer.from(data);
    let out: Buffer;
    try {
      out = execSync(cmd, {
        input,
        // Do NOT leak kit's env wholesale into the signer; pass only what it needs.
        env: { ...process.env, KIT_SIGN_ALGO: "ed25519" },
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 30_000,
        maxBuffer: 1 << 20,
      });
    } catch (e) {
      throw new Error(`${SIGN_CMD_ENV} failed: ${(e as Error).message}`);
    }
    const b64 = out.toString("utf-8").trim();
    if (!b64) throw new Error(`${SIGN_CMD_ENV} produced no signature on stdout`);
    let sig: Buffer;
    try {
      sig = Buffer.from(b64, "base64");
      if (sig.length === 0) throw new Error("empty");
    } catch {
      throw new Error(`${SIGN_CMD_ENV} did not emit a base64 signature`);
    }
    const pub = readPubkeyPem();
    if (!pub || !verifySignature(input, sig, pub)) {
      throw new Error(
        `${SIGN_CMD_ENV} returned a signature that does NOT verify against ${PUBKEY_ENV} — refusing it (wrong key, or a compromised/misconfigured signer)`,
      );
    }
    return sig;
  }

  /**
   * Idempotent adopt: the hardware key is provisioned OUT OF BAND (in the TPM/HSM/
   * enclave), so there is nothing to generate — we simply surface the identity derived
   * from the configured public key. `created` is always false: kit never mints a
   * hardware key. Fail-closed if not configured.
   */
  create(now: string = new Date().toISOString()): { identity: Identity; created: boolean } {
    const avail = this.available();
    if (!avail.ok) throw new Error(avail.reason);
    const publicKey = readPubkeyPem()!;
    return {
      identity: { id: identityId(publicKey), algo: "ed25519", publicKey, createdAt: now },
      created: false,
    };
  }

  /**
   * Rotation of a hardware key is an out-of-band operator action (provision a new key
   * in the device, then repoint KIT_KEYSTORE_PUBKEY). kit refuses to fake it.
   */
  rotate(_now?: string): { identity: Identity; previousId: string | null } {
    throw new Error(
      "command keystore: rotate the hardware key out of band (in the TPM/HSM/enclave), then update " +
        `${PUBKEY_ENV} — kit does not rotate a key it cannot hold`,
    );
  }
}
