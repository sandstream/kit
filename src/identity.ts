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
  appendFileSync,
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
const REVOCATIONS_FILE = "revocations.jsonl"; // append-only signed revocation records (0600)

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
    if (!rec || typeof rec.id !== "string" || typeof rec.publicKey !== "string") return;
    // A kid IS the fingerprint of its public key, so re-derive and require the match.
    // Without this, a writer-only attacker could drop a crafted identity.json.*.bak
    // (or overwrite the record) claiming `{id: <a victim/authority kid>, publicKey:
    // <attacker key>}` — poisoning this kid→pubkey map so a forged revocation "by"
    // that kid verifies against the attacker's key. Binding kid==fingerprint(pub)
    // makes the map unspoofable: the attacker can't produce a key whose fingerprint
    // is someone else's kid.
    try {
      if (identityId(rec.publicKey) !== rec.id) return;
    } catch {
      return; // unparseable public key → skip
    }
    map.set(rec.id, rec.publicKey);
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
 * A signed revocation record. `kid` is the revoked identity; `by` is the
 * identity that signed the revocation (normally the freshly-rotated one); `sig`
 * is its Ed25519 signature over the canonical statement (see revocationStatement).
 * Asymmetric payoff: a revocation propagates as PUBLIC data — anyone with the
 * signer's public key can verify it, no shared secret required.
 */
export interface RevocationRecord {
  kid: string;
  reason: string;
  ts: string;
  by: string;
  sig: string;
}

/** Canonical bytes signed for a revocation — stable across machines for verify. */
export function revocationStatement(kid: string, ts: string, reason: string): string {
  return `kit-revoke\nkid=${kid}\nts=${ts}\nreason=${reason}`;
}

function revocationsPath(dir?: string): string {
  return join(identityDir(dir), REVOCATIONS_FILE);
}

/**
 * Append a signed revocation of `kid`, signed by the CURRENT identity (after a
 * rotate, that's the new key vouching "I revoke my old key"). Append-only +
 * 0600. Returns the record. Throws if there is no current identity to sign with.
 */
export function recordRevocation(
  kid: string,
  reason: string,
  dir?: string,
  now: string = new Date().toISOString(),
): RevocationRecord {
  const signer = tryLoadIdentity(dir);
  if (!signer) throw new Error("no current identity to sign the revocation");
  const sig = signWithIdentity(revocationStatement(kid, now, reason), dir).toString("base64");
  const rec: RevocationRecord = { kid, reason, ts: now, by: signer.id, sig };
  const path = revocationsPath(dir);
  mkdirSync(identityDir(dir), { recursive: true });
  appendFileSync(path, JSON.stringify(rec) + "\n", { encoding: "utf-8", mode: 0o600 });
  secureFile(path);
  return rec;
}

/**
 * Append already-formed revocation records to the local append-only log, skipping
 * any already present (dedup by kid+ts+sig). Unlike `recordRevocation`, this does
 * NOT sign — the caller is responsible for having VERIFIED each record's signature
 * first (used by control-plane revocation propagation, which verifies against the
 * org trust anchor before merging). Returns the number of new records written.
 */
export function appendRevocations(records: RevocationRecord[], dir?: string): number {
  if (records.length === 0) return 0;
  const seen = new Set(loadRevocations(dir).map((r) => `${r.kid}\n${r.ts}\n${r.sig}`));
  const fresh = records.filter((r) => !seen.has(`${r.kid}\n${r.ts}\n${r.sig}`));
  if (fresh.length === 0) return 0;
  const path = revocationsPath(dir);
  mkdirSync(identityDir(dir), { recursive: true });
  appendFileSync(path, fresh.map((r) => JSON.stringify(r)).join("\n") + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
  secureFile(path);
  return fresh.length;
}

/** All revocation records on this machine (append-only log). Best-effort: [] if absent. */
export function loadRevocations(dir?: string): RevocationRecord[] {
  try {
    return readFileSync(revocationsPath(dir), "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as RevocationRecord);
  } catch {
    return [];
  }
}

/**
 * Is `rec` an AUTHORITATIVE revocation — one kit should actually honor? A record is
 * honored only when BOTH hold:
 *   1. its Ed25519 signature verifies against `by`'s public key (from `trustedKeys`);
 *   2. `by` has AUTHORITY over `kid`: either `by === kid` (a key revoking itself, incl.
 *      the rotation case where the successor id equals the record's own), or `by` is in
 *      `authorities` (a trust-anchor set — org signers and/or this machine's local root).
 *
 * This is the fix for cross-signer revocation authority: without it, `isRevoked` was a
 * bare existence check over `revocations.jsonl`, so ANY line — unsigned, or signed by a
 * key with no authority over the target — revoked the target. A writer-only attacker
 * could plant `{kid: <an org signer>}` and make the org's validly-signed policy verify as
 * "revoked" (a fail-closed DoS on the real trust anchor), or revoke an arbitrary RBAC
 * subject. Requiring a valid signature by an authorized revoker closes both: the attacker
 * cannot forge an Ed25519 signature by an authority key. Pure; fail-closed on any doubt.
 */
export function isAuthoritativeRevocation(
  rec: RevocationRecord,
  trustedKeys: Map<string, string>,
  authorities: Set<string>,
): boolean {
  if (
    !rec ||
    typeof rec.kid !== "string" ||
    typeof rec.by !== "string" ||
    typeof rec.ts !== "string" ||
    typeof rec.reason !== "string" ||
    typeof rec.sig !== "string"
  ) {
    return false;
  }
  if (rec.by !== rec.kid && !authorities.has(rec.by)) return false; // unauthorized revoker
  const pub = trustedKeys.get(rec.by);
  if (!pub) return false; // revoker's public key unknown → can't verify → don't honor
  return verifySignature(
    revocationStatement(rec.kid, rec.ts, rec.reason),
    Buffer.from(rec.sig, "base64"),
    pub,
  );
}

/** kids carrying at least one AUTHORITATIVE revocation under the given trust context. */
export function revokedKids(
  trustedKeys: Map<string, string>,
  authorities: Set<string>,
  dir?: string,
): Set<string> {
  const out = new Set<string>();
  for (const rec of loadRevocations(dir)) {
    if (isAuthoritativeRevocation(rec, trustedKeys, authorities)) out.add(rec.kid);
  }
  return out;
}

/**
 * Authority-aware revocation check against an explicit trust context. Callers that know
 * the org trust anchor (e.g. policy verification) pass the org signers so org-propagated
 * revocations are honored; a local-only caller passes just the machine's own keys.
 */
export function isRevokedWith(
  kid: string,
  trustedKeys: Map<string, string>,
  authorities: Set<string>,
  dir?: string,
): boolean {
  return loadRevocations(dir).some(
    (r) => r.kid === kid && isAuthoritativeRevocation(r, trustedKeys, authorities),
  );
}

/**
 * LOCAL revocation authorities for this machine: the current identity is the local trust
 * root (and is the rotation successor of its own archived keys, which it signs revocations
 * with). Every key can additionally self-revoke (handled in isAuthoritativeRevocation).
 */
export function localRevocationAuthorities(dir?: string): Set<string> {
  const cur = tryLoadIdentity(dir);
  return new Set<string>(cur ? [cur.id] : []);
}

/**
 * True if `kid` is revoked under this machine's LOCAL trust context (its own current +
 * archived keys; the current identity as authority). Org-anchor-signed revocations are
 * honored by callers that pass the org context via `isRevokedWith` (see policy-doc). This
 * no longer honors unsigned/unauthorized records — it verifies signature + authority.
 */
export function isRevoked(kid: string, dir?: string): boolean {
  return isRevokedWith(kid, localPublicKeys(dir), localRevocationAuthorities(dir), dir);
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
