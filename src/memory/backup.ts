/**
 * kit memory — encrypted backup / restore.
 *
 * The personal store is local-only (0600) — a stolen laptop loses it. This makes
 * an ENCRYPTED, portable backup so you can restore your whole brain on a new
 * machine. AES-256-GCM with a scrypt-derived key from a passphrase the operator
 * supplies (and which is NEVER stored). Zero dependencies (node:crypto). The
 * encrypted blob can live anywhere — Turso, object storage, a USB stick — and is
 * the transport for the future opt-in live sync.
 *
 * Blob layout: MAGIC(8) | salt(16) | iv(12) | authTag(16) | ciphertext
 * The MAGIC byte is versioned so the scrypt KDF cost can be raised without
 * breaking older backups: V1 used scrypt defaults; V2 uses a hardened cost.
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  generateKeyPairSync,
  createPublicKey,
  createPrivateKey,
  diffieHellman,
  hkdfSync,
  type ScryptOptions,
  type KeyObject,
} from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openMemoryDb, getMemoryDbPath, getMemoryDir } from "./db.js";

const MAGIC_V1 = Buffer.from("KITMEM01"); // legacy: scrypt defaults (N=16384, ~16 MB)
const MAGIC_V2 = Buffer.from("KITMEM02"); // hardened: N=2^17 (~134 MB) — write path
const MAGIC_V3 = Buffer.from("KITMEM03"); // asymmetric: X25519 → HKDF → AES-256-GCM (no passphrase)
const MAGIC_LEN = 8;
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const X25519_LEN = 32; // raw X25519 public key length

// Hardened scrypt cost for new backups. The blob is the ONLY thing a passphrase
// protects and is designed to sit on a USB stick / in the cloud, so make offline
// cracking expensive. maxmem must be raised to fit N=2^17.
const SCRYPT_V2: ScryptOptions = { N: 1 << 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };

function deriveKey(passphrase: string, salt: Buffer, opts?: ScryptOptions): Buffer {
  return scryptSync(passphrase, salt, 32, opts);
}

// The plaintext DB is gzip-compressed BEFORE encryption (a SQLite file is highly
// compressible — ~139 MB → ~30 MB — which keeps the blob under a 100 MB git host
// limit and speeds every transport). Compression is INSIDE the encryption, so the
// remote still only ever sees ciphertext. Backward-compatible on read: an older
// (uncompressed) blob decrypts to a raw SQLite file that lacks the gzip header, so
// `maybeGunzip` passes it through untouched — no new format version needed.
function readMemoryDbCompressed(srcPath: string): Buffer {
  return gzipSync(readFileSync(srcPath));
}

// Hard ceiling on the decompressed size. A V3 (public-key) blob is near-unauthenticated —
// the recipient public key is meant to be shared, so anyone can craft a VALID blob whose
// plaintext is a gzip bomb (a few KB → many GB). Without a cap, `kit memory pull` of such a
// blob exhausts memory on the durable box. 1 GiB is well above a real brain (a large store
// is ~139 MB uncompressed) while bounding a bomb; an over-limit blob throws a clear error
// instead of OOMing.
const MAX_DECOMPRESSED_BYTES = 1024 * 1024 * 1024;

/** Gunzip if the buffer carries the gzip magic (0x1f 0x8b); otherwise return as-is
 *  (a pre-compression blob, whose plaintext is a raw SQLite file). Bounded output so a
 *  crafted blob can't decompress into a memory-exhausting gzip bomb. `maxBytes` is a test
 *  seam; production callers use the default 1 GiB ceiling. */
export function maybeGunzip(buf: Buffer, maxBytes: number = MAX_DECOMPRESSED_BYTES): Buffer {
  if (!(buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b)) return buf;
  try {
    return gunzipSync(buf, { maxOutputLength: maxBytes });
  } catch (e) {
    if (e instanceof RangeError) {
      throw new Error(
        `backup decompresses beyond the ${Math.round(maxBytes / (1024 * 1024))} MB limit — refusing (possible gzip bomb)`,
      );
    }
    throw e;
  }
}

const MIN_PASSPHRASE_LEN = 12;
// Substrings that mark an obviously guessable / placeholder passphrase. A long
// phrase is worthless if it is predictable — the passphrase is the ONLY thing
// protecting an encrypted backup that may sit on a USB stick or in the cloud.
const WEAK_MARKERS = [
  "passphrase",
  "password",
  "changeme",
  "example",
  "valfri",
  "correct horse",
  "testpass",
  "123456",
];

/** Reject a too-short or obviously-weak backup passphrase (fail before encrypting). */
export function validatePassphrase(passphrase: string): void {
  if (passphrase.length < MIN_PASSPHRASE_LEN) {
    throw new Error(
      `passphrase too weak: use at least ${MIN_PASSPHRASE_LEN} characters — it is the only thing protecting your encrypted backup`,
    );
  }
  const low = passphrase.toLowerCase();
  if (WEAK_MARKERS.some((m) => low.includes(m))) {
    throw new Error(
      "passphrase too weak: it looks like an example/placeholder — choose a long, non-obvious phrase",
    );
  }
}

function magicOf(inPath: string): Buffer | null {
  try {
    return readFileSync(inPath).subarray(0, MAGIC_LEN);
  } catch {
    return null; // unreadable/missing — let the caller surface a clean error
  }
}

/** True if `inPath` begins with ANY kit memory backup MAGIC header (V1/V2 passphrase
 *  or V3 public-key). Lets `kit memory sync` tell an encrypted backup from a raw .db. */
export function isEncryptedBackup(inPath: string): boolean {
  const m = magicOf(inPath);
  return !!m && (m.equals(MAGIC_V1) || m.equals(MAGIC_V2) || m.equals(MAGIC_V3));
}

/** True only for a V3 (asymmetric, public-key) blob — decrypts with the local
 *  private key, never a passphrase. The branch `kit memory pull` keys off. */
export function isAsymmetricBackup(inPath: string): boolean {
  const m = magicOf(inPath);
  return !!m && m.equals(MAGIC_V3);
}

/** Encrypt the memory DB file into `outPath`. WAL is checkpointed first so the file is complete. */
export function backupEncrypted(
  passphrase: string,
  srcPath: string = getMemoryDbPath(),
  outPath?: string,
): void {
  if (!outPath) throw new Error("backupEncrypted requires an output path");
  validatePassphrase(passphrase);
  // Flush WAL into the main file so reading the .db captures everything.
  const db = openMemoryDb(srcPath);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();

  const data = readMemoryDbCompressed(srcPath);
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(passphrase, salt, SCRYPT_V2), iv, {
    authTagLength: TAG_LEN,
  });
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  // 0600: the blob is encrypted, but there is no reason to leave your whole
  // (encrypted) brain world-readable on a shared host.
  writeFileSync(outPath, Buffer.concat([MAGIC_V2, salt, iv, tag, ciphertext]), { mode: 0o600 });
}

/**
 * Write an UNENCRYPTED, consistent snapshot of the memory DB to `outPath` (SQLite
 * `VACUUM INTO` after a WAL checkpoint → a standalone .db the pull side merges directly).
 * For the low-ceremony `[memory.sync] encrypt = false` option: no passphrase, no recipient.
 * The blob is plaintext, so the sync DESTINATION MUST be private (the store can hold
 * secret-shaped strings) — the pull path still runs the R7 injection scan before merge.
 * 0600 like every other kit-written store file.
 */
export function backupPlain(srcPath: string = getMemoryDbPath(), outPath?: string): void {
  if (!outPath) throw new Error("backupPlain requires an output path");
  const db = openMemoryDb(srcPath);
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    // VACUUM INTO requires the target not to exist (a prior blob may have been pulled in).
    if (existsSync(outPath)) rmSync(outPath);
    db.exec(`VACUUM INTO '${outPath.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
  chmodSync(outPath, 0o600);
}

/** Decrypt a backup blob into `destPath`. Throws on a wrong passphrase or tampered blob (GCM auth). */
export function restoreEncrypted(passphrase: string, inPath: string, destPath: string): void {
  const blob = readFileSync(inPath);
  const magic = blob.subarray(0, MAGIC_LEN);
  // Pick the KDF cost from the version tag so older (V1) backups still restore.
  let scrypt: ScryptOptions | undefined;
  if (magic.equals(MAGIC_V2)) scrypt = SCRYPT_V2;
  else if (magic.equals(MAGIC_V1))
    scrypt = undefined; // legacy scrypt defaults
  else throw new Error("not a kit memory backup (bad magic)");

  let off = MAGIC_LEN;
  const salt = blob.subarray(off, (off += SALT_LEN));
  const iv = blob.subarray(off, (off += IV_LEN));
  const tag = blob.subarray(off, (off += TAG_LEN));
  const ciphertext = blob.subarray(off);
  const decipher = createDecipheriv("aes-256-gcm", deriveKey(passphrase, salt, scrypt), iv, {
    authTagLength: TAG_LEN,
  });
  decipher.setAuthTag(tag);
  const data = Buffer.concat([decipher.update(ciphertext), decipher.final()]); // throws if wrong key
  // 0600: never leave the decrypted plaintext brain world-readable, even when
  // restoring to a custom path outside ~/.kit. (openMemoryDb chmods the live DB;
  // this is the restore-time equivalent.)
  writeFileSync(destPath, maybeGunzip(data), { mode: 0o600 });
}

// ── Asymmetric (public-key) mode ──────────────────────────────────────────────
// Why: the symmetric passphrase must live on EVERY machine that pushes — which an
// ephemeral session (no secret-safe env, no SSH key) can't do. Public-key mode
// flips it: a session encrypts to a PUBLIC recipient key (not a secret — safe in a
// setup script, env var, or the repo), and only the durable machines holding the
// PRIVATE key can decrypt. So an ephemeral session needs nothing secret to push.
//
// Scheme (libsodium sealed-box shape, pure node:crypto — zero deps): a fresh
// ephemeral X25519 keypair per blob; ECDH(eph_priv, recipient_pub) → HKDF-SHA256
// (salt = eph_pub||recipient_pub, info = "kit-memory-v3") → 32-byte AES key →
// AES-256-GCM. Layout: MAGIC_V3(8) | eph_pub(32) | iv(12) | tag(16) | ciphertext.

const HKDF_INFO = Buffer.from("kit-memory-v3");
const PUB_PREFIX = "kitmem-pub-";

/** A stored X25519 private key (JWK OKP form: has both `d` and `x`). */
export interface MemoryKeyJwk {
  kty: "OKP";
  crv: "X25519";
  x: string; // base64url public component
  d: string; // base64url private scalar
}

function rawFromJwkComponent(b64url: string): Buffer {
  return Buffer.from(b64url, "base64url");
}

/** The recipient public string for a JWK/`x` — safe to share (NOT a secret). */
export function publicKeyString(x: string): string {
  return PUB_PREFIX + x;
}

/** Parse a `kitmem-pub-…` recipient string into an X25519 public KeyObject. */
export function parseRecipient(pub: string): KeyObject {
  if (!pub.startsWith(PUB_PREFIX)) {
    throw new Error(`invalid recipient key: must start with "${PUB_PREFIX}"`);
  }
  const x = pub.slice(PUB_PREFIX.length).trim();
  if (rawFromJwkComponent(x).length !== X25519_LEN) {
    throw new Error("invalid recipient key: not a 32-byte X25519 public key");
  }
  try {
    return createPublicKey({ key: { kty: "OKP", crv: "X25519", x }, format: "jwk" });
  } catch {
    throw new Error("invalid recipient key: could not parse X25519 public key");
  }
}

/** Where the local private decryption key lives (0600), honoring KIT_MEMORY_DIR. */
export function getMemoryKeyPath(): string {
  return join(getMemoryDir(), "memory-key.json");
}

/** Generate a fresh X25519 keypair. Returns the shareable public string and the
 *  private JWK to persist on durable machines only. */
export function generateMemoryKeypair(): { publicKey: string; privateJwk: MemoryKeyJwk } {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const priv = privateKey.export({ format: "jwk" }) as unknown as MemoryKeyJwk;
  const pub = publicKey.export({ format: "jwk" }) as { x: string };
  return { publicKey: publicKeyString(pub.x), privateJwk: { ...priv, x: pub.x } };
}

/** Persist the private key (0600) and return the file path. */
export function saveMemoryKey(privateJwk: MemoryKeyJwk): string {
  const dir = getMemoryDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = getMemoryKeyPath();
  writeFileSync(path, JSON.stringify(privateJwk), { mode: 0o600 });
  return path;
}

/** Load the local private key, or null if none exists / is unreadable. */
export function loadMemoryKey(): MemoryKeyJwk | null {
  try {
    const j = JSON.parse(readFileSync(getMemoryKeyPath(), "utf8")) as MemoryKeyJwk;
    return j.kty === "OKP" && j.crv === "X25519" && j.d && j.x ? j : null;
  } catch {
    return null;
  }
}

function deriveSharedKey(ephPubRaw: Buffer, recipPubRaw: Buffer, shared: Buffer): Buffer {
  const salt = Buffer.concat([ephPubRaw, recipPubRaw]);
  return Buffer.from(hkdfSync("sha256", shared, salt, HKDF_INFO, 32));
}

/** Encrypt the memory DB to a PUBLIC recipient key (no passphrase). WAL-checkpoint first. */
export function backupToRecipient(
  recipient: string,
  srcPath: string = getMemoryDbPath(),
  outPath?: string,
): void {
  if (!outPath) throw new Error("backupToRecipient requires an output path");
  const recipKey = parseRecipient(recipient);
  const recipRaw = rawFromJwkComponent((recipKey.export({ format: "jwk" }) as { x: string }).x);

  const db = openMemoryDb(srcPath);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  const data = readMemoryDbCompressed(srcPath);

  const { publicKey: ephPub, privateKey: ephPriv } = generateKeyPairSync("x25519");
  const ephRaw = rawFromJwkComponent((ephPub.export({ format: "jwk" }) as { x: string }).x);
  const shared = diffieHellman({ privateKey: ephPriv, publicKey: recipKey });
  const key = deriveSharedKey(ephRaw, recipRaw, shared);

  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_LEN });
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  writeFileSync(outPath, Buffer.concat([MAGIC_V3, ephRaw, iv, tag, ciphertext]), { mode: 0o600 });
}

/** Decrypt a V3 blob with the local private key. Throws on wrong key / tamper (GCM auth). */
export function restoreWithKey(privateJwk: MemoryKeyJwk, inPath: string, destPath: string): void {
  const blob = readFileSync(inPath);
  if (!blob.subarray(0, MAGIC_LEN).equals(MAGIC_V3)) {
    throw new Error("not a kit public-key backup (bad magic)");
  }
  let off = MAGIC_LEN;
  const ephRaw = blob.subarray(off, (off += X25519_LEN));
  const iv = blob.subarray(off, (off += IV_LEN));
  const tag = blob.subarray(off, (off += TAG_LEN));
  const ciphertext = blob.subarray(off);

  const privKey = createPrivateKey({
    key: { kty: "OKP", crv: "X25519", x: privateJwk.x, d: privateJwk.d },
    format: "jwk",
  });
  const ephPub = createPublicKey({
    key: { kty: "OKP", crv: "X25519", x: ephRaw.toString("base64url") },
    format: "jwk",
  });
  const shared = diffieHellman({ privateKey: privKey, publicKey: ephPub });
  const recipRaw = rawFromJwkComponent(privateJwk.x);
  const key = deriveSharedKey(ephRaw, recipRaw, shared);

  const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_LEN });
  decipher.setAuthTag(tag);
  const data = Buffer.concat([decipher.update(ciphertext), decipher.final()]); // throws if wrong key
  writeFileSync(destPath, maybeGunzip(data), { mode: 0o600 });
}
