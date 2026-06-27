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
  type ScryptOptions,
} from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { openMemoryDb, getMemoryDbPath } from "./db.js";

const MAGIC_V1 = Buffer.from("KITMEM01"); // legacy: scrypt defaults (N=16384, ~16 MB)
const MAGIC_V2 = Buffer.from("KITMEM02"); // hardened: N=2^17 (~134 MB) — write path
const MAGIC_LEN = 8;
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;

// Hardened scrypt cost for new backups. The blob is the ONLY thing a passphrase
// protects and is designed to sit on a USB stick / in the cloud, so make offline
// cracking expensive. maxmem must be raised to fit N=2^17.
const SCRYPT_V2: ScryptOptions = { N: 1 << 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };

function deriveKey(passphrase: string, salt: Buffer, opts?: ScryptOptions): Buffer {
  return scryptSync(passphrase, salt, 32, opts);
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

/** True if `inPath` begins with a kit memory backup MAGIC header (V1 or V2).
 *  Lets `kit memory sync` tell an encrypted backup from a raw .db export. */
export function isEncryptedBackup(inPath: string): boolean {
  let head: Buffer;
  try {
    const fd = readFileSync(inPath);
    head = fd.subarray(0, MAGIC_LEN);
  } catch {
    return false; // unreadable/missing — let the caller surface a clean error
  }
  return head.equals(MAGIC_V1) || head.equals(MAGIC_V2);
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

  const data = readFileSync(srcPath);
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
  writeFileSync(destPath, data, { mode: 0o600 });
}
