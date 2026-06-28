/**
 * kit identity — a machine/agent-local cryptographic identity (3.0 Phase 0).
 *
 * 2.0's audit chain is HMAC-anchored: tamper-EVIDENT, but symmetric — a verifier
 * holds the same secret that signs (so sharing it shares forge power), and there
 * is no notion of *who* produced an entry. An Ed25519 identity adds what an HMAC
 * structurally cannot: ASYMMETRIC, ATTRIBUTABLE provenance — anyone can verify
 * with the PUBLIC key that an artifact came from this identity, while only the
 * holder of the private key can produce it. That asymmetry is the spine the 3.0
 * control plane (signed policy, fleet RBAC, identity-signed audit) builds on.
 *
 * HONEST THREAT BOUNDARY: the private key is a 0600 file under ~/.kit, so a
 * same-UID local principal can read it and sign as this identity — the SAME
 * same-UID limit the HMAC audit anchor documents. What the keypair buys *today*
 * is asymmetric, offline, third-party-verifiable attribution: a remote / CI /
 * teammate verifier needs only the PUBLIC key, never a forge-capable secret.
 * Closing the same-UID gap needs non-exportable key storage (TPM / OS keychain /
 * HSM) — the 3.0 regulated tier, not this layer.
 *
 * Local-first, zero-dep (node:crypto), deterministic verify, no network.
 */
import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  sign as edSign,
  verify as edVerify,
  createHash,
} from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { secureFile } from "./utils/secure-perms.js";

const KEY_FILE = "identity.key"; // PKCS8 PEM private key (0600)
const RECORD_FILE = "identity.json"; // public identity record (0600)

export interface Identity {
  /** Stable, non-secret id derived from the public key. */
  id: string;
  algo: "ed25519";
  /** SPKI PEM — safe to distribute; this is what verifiers need. */
  publicKey: string;
  /** ISO-8601 creation time. */
  createdAt: string;
}

/** Directory holding the identity key + record (default ~/.kit; KIT_IDENTITY_DIR override). */
export function identityDir(override?: string): string {
  if (override) return override;
  if (process.env.KIT_IDENTITY_DIR) return process.env.KIT_IDENTITY_DIR;
  return join(homedir(), ".kit");
}

function keyPath(dir?: string): string {
  return join(identityDir(dir), KEY_FILE);
}
function recordPath(dir?: string): string {
  return join(identityDir(dir), RECORD_FILE);
}

/** Stable, non-secret identity id from a public key (PEM). Pure. */
export function identityId(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  return "kid_" + createHash("sha256").update(der).digest("hex").slice(0, 32);
}

/** Verify an Ed25519 signature over `data` with a public key (PEM). Pure, no I/O, never throws. */
export function verifySignature(
  data: Buffer | string,
  signature: Buffer,
  publicKeyPem: string,
): boolean {
  try {
    const msg = Buffer.isBuffer(data) ? data : Buffer.from(data);
    return edVerify(null, msg, createPublicKey(publicKeyPem), signature);
  } catch {
    return false; // malformed key/sig → not verified (fail-closed)
  }
}

/** Load the identity record if present (read-only). Null when absent/unreadable. */
export function tryLoadIdentity(dir?: string): Identity | null {
  try {
    const rec = JSON.parse(readFileSync(recordPath(dir), "utf-8")) as Identity;
    if (rec && typeof rec.publicKey === "string" && typeof rec.id === "string") return rec;
    return null;
  } catch {
    return null;
  }
}

function generateIdentity(now: string): { privatePem: string; identity: Identity } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicPem = publicKey.export({ type: "spki", format: "pem" }) as string;
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  return {
    privatePem,
    identity: { id: identityId(publicPem), algo: "ed25519", publicKey: publicPem, createdAt: now },
  };
}

function writeIdentity(dir: string | undefined, privatePem: string, rec: Identity): void {
  mkdirSync(identityDir(dir), { recursive: true });
  writeFileSync(keyPath(dir), privatePem, { encoding: "utf-8", mode: 0o600 });
  secureFile(keyPath(dir)); // owner-only on Windows (NTFS ignores mode)
  writeFileSync(recordPath(dir), JSON.stringify(rec, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
  secureFile(recordPath(dir));
}

/** Load the identity, creating one on first use. `now` injectable for tests. */
export function loadOrCreateIdentity(
  dir?: string,
  now: string = new Date().toISOString(),
): { identity: Identity; created: boolean } {
  const existing = tryLoadIdentity(dir);
  if (existing && existsSync(keyPath(dir))) return { identity: existing, created: false };
  const { privatePem, identity } = generateIdentity(now);
  writeIdentity(dir, privatePem, identity);
  return { identity, created: true };
}

/**
 * Build a kid → public-key (PEM) map from the locally-known identity records:
 * the current identity plus any archived `identity.json.*.bak` records left by
 * rotation (so entries signed by a previous, rotated key still verify). This is
 * the Phase-0 local trust store; a shared/fleet trust store + revocation list
 * layer on top later. Best-effort: unreadable/malformed records are skipped.
 */
export function localPublicKeys(dir?: string): Map<string, string> {
  const map = new Map<string, string>();
  const base = identityDir(dir);
  const add = (rec: Identity | null) => {
    if (rec && typeof rec.id === "string" && typeof rec.publicKey === "string") {
      map.set(rec.id, rec.publicKey);
    }
  };
  add(tryLoadIdentity(dir));
  try {
    for (const name of readdirSync(base)) {
      if (!name.startsWith(`${RECORD_FILE}.`) || !name.endsWith(".bak")) continue;
      try {
        add(JSON.parse(readFileSync(join(base, name), "utf-8")) as Identity);
      } catch {
        /* skip malformed archived record */
      }
    }
  } catch {
    /* identity dir absent → just the current identity (if any) */
  }
  return map;
}

/** Sign data with the identity's private key (Ed25519). Throws if no identity exists. */
export function signWithIdentity(data: Buffer | string, dir?: string): Buffer {
  const pem = readFileSync(keyPath(dir), "utf-8");
  const msg = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return edSign(null, msg, createPrivateKey(pem));
}

/**
 * Rotate the identity: archive the old key + record (so artifacts signed by the
 * previous identity stay verifiable with the archived public key) and generate a
 * fresh keypair. Returns the new identity + the previous id (null if none).
 */
export function rotateIdentity(
  dir?: string,
  now: string = new Date().toISOString(),
): { identity: Identity; previousId: string | null } {
  const prev = tryLoadIdentity(dir);
  if (prev && existsSync(keyPath(dir))) {
    const stamp = now.replace(/[:.]/g, "-");
    try {
      renameSync(keyPath(dir), `${keyPath(dir)}.${stamp}.bak`);
    } catch {
      /* best-effort archive */
    }
    try {
      renameSync(recordPath(dir), `${recordPath(dir)}.${stamp}.bak`);
    } catch {
      /* best-effort archive */
    }
  }
  const { privatePem, identity } = generateIdentity(now);
  writeIdentity(dir, privatePem, identity);
  return { identity, previousId: prev?.id ?? null };
}
