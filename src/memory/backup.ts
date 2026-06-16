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
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { openMemoryDb, getMemoryDbPath } from "./db.js";

const MAGIC = Buffer.from("KITMEM01");
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32);
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
  const cipher = createCipheriv("aes-256-gcm", deriveKey(passphrase, salt), iv);
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  writeFileSync(outPath, Buffer.concat([MAGIC, salt, iv, tag, ciphertext]));
}

/** Decrypt a backup blob into `destPath`. Throws on a wrong passphrase or tampered blob (GCM auth). */
export function restoreEncrypted(passphrase: string, inPath: string, destPath: string): void {
  const blob = readFileSync(inPath);
  if (!blob.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error("not a kit memory backup (bad magic)");
  }
  let off = MAGIC.length;
  const salt = blob.subarray(off, (off += SALT_LEN));
  const iv = blob.subarray(off, (off += IV_LEN));
  const tag = blob.subarray(off, (off += TAG_LEN));
  const ciphertext = blob.subarray(off);
  const decipher = createDecipheriv("aes-256-gcm", deriveKey(passphrase, salt), iv);
  decipher.setAuthTag(tag);
  const data = Buffer.concat([decipher.update(ciphertext), decipher.final()]); // throws if wrong key
  writeFileSync(destPath, data);
}
