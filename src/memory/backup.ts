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
 * Current blobs use independently authenticated 1 MiB frames, so neither backup
 * nor restore buffers a whole database. The versioned MAGIC retains streaming
 * compatibility with the older one-shot V1/V2/V3 formats.
 */
import {
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
import {
  readFileSync,
  readSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  lstatSync,
  statSync,
  realpathSync,
  readlinkSync,
  openSync,
  fstatSync,
  constants,
  fchmodSync,
  closeSync,
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getMemoryDbPath, getMemoryDir } from "./db.js";
import { assertRecoveryCompatible } from "./pal-check-storage.js";
import { assertActionDeletionsPreserved } from "./pal-recovery.js";
import {
  copyFileToDescriptor,
  restoreChunkedFile,
  restoreLegacyFile,
  SIZE_HEADER_LEN,
  sizeHeader,
  writeChunkedSnapshot,
} from "./backup-stream.js";

const MAGIC_V1 = Buffer.from("KITMEM01"); // legacy: scrypt defaults (N=16384, ~16 MB)
const MAGIC_V2 = Buffer.from("KITMEM02"); // hardened: N=2^17 (~134 MB) — write path
const MAGIC_V3 = Buffer.from("KITMEM03"); // asymmetric: X25519 → HKDF → AES-256-GCM (no passphrase)
const MAGIC_V4 = Buffer.from("KITMEM04"); // chunked V2 successor: bounded gzip + AES-256-GCM
const MAGIC_V5 = Buffer.from("KITMEM05"); // chunked V3 successor: X25519 + bounded gzip/GCM
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

function destinationPath(path: string): string {
  let target = resolve(path);
  for (let links = 0; links < 40; links++) {
    const entry = lstatSync(target, { throwIfNoEntry: false });
    if (!entry?.isSymbolicLink()) {
      if (entry) return realpathSync(target);
      const suffix = [basename(target)];
      let ancestor = dirname(target);
      while (!lstatSync(ancestor, { throwIfNoEntry: false })) {
        suffix.unshift(basename(ancestor));
        ancestor = dirname(ancestor);
      }
      return join(realpathSync(ancestor), ...suffix);
    }
    // Follow dangling links too: their targets may be not-yet-created WAL files.
    target = resolve(dirname(target), readlinkSync(target));
  }
  throw new Error("too many symbolic links in backup destination");
}

function assertDistinctFiles(input: string, output: string, sqlite: boolean): void {
  const source = realpathSync(input);
  const destination = destinationPath(output);
  const target = statSync(destination, { throwIfNoEntry: false });
  const suffixes = sqlite ? ["", "-wal", "-shm", "-journal"] : [""];
  for (const base of new Set([source, resolve(input)])) {
    for (const suffix of suffixes) {
      const protectedPath = destinationPath(base + suffix);
      const original = statSync(protectedPath, { throwIfNoEntry: false });
      if (
        destination === protectedPath ||
        destination.startsWith(protectedPath + sep) ||
        (original && target && original.dev === target.dev && original.ino === target.ino)
      ) {
        throw new Error(
          "backup input and output must be different files (including SQLite sidecar aliases)",
        );
      }
    }
  }
}

function assertOfflineDestination(destination: string): void {
  if (
    ["-wal", "-shm", "-journal"].some((suffix) =>
      lstatSync(destination + suffix, { throwIfNoEntry: false }),
    )
  ) {
    throw new Error(
      "SQLite sidecar exists at restore destination; restore offline after closing database users, or choose a new path",
    );
  }
}

type RestorePurpose = "recovery" | "import";

function writeBackupFile(
  input: string,
  output: string,
  write: Buffer | ((fd: number) => void),
  purpose: RestorePurpose | "backup" = "recovery",
): void {
  const sqlite = purpose === "backup";
  assertDistinctFiles(input, output, sqlite);
  const destination = destinationPath(output);
  if (!sqlite) assertOfflineDestination(destination);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  assertDistinctFiles(input, destination, sqlite);
  const temporary = join(
    dirname(destination),
    `.kit-memory-${randomBytes(16).toString("hex")}.tmp`,
  );
  const fd = openSync(temporary, "wx", 0o600);
  try {
    try {
      // Set exact permissions on the empty, owned inode before any plaintext.
      fchmodSync(fd, 0o600);
      if (Buffer.isBuffer(write)) writeFileSync(fd, write);
      else write(fd);
    } finally {
      closeSync(fd);
    }
    if (purpose === "recovery") assertRecoveryCompatible(temporary);
    assertDistinctFiles(input, destination, sqlite);
    if (!sqlite) assertOfflineDestination(destination);
    if (purpose === "recovery") assertActionDeletionsPreserved(temporary, destination);
    if (!sqlite) assertOfflineDestination(destination);
    renameSync(temporary, destination);
  } finally {
    for (const suffix of ["", "-wal", "-shm", "-journal"])
      rmSync(temporary + suffix, { force: true });
  }
}

// Capture one committed SQLite snapshot before the format-specific writer runs.
// Current V4/V5 writers compress and authenticate independent 1 MiB frames; legacy
// V1-V3 readers use bounded staging streams for backward compatibility.
function withMemoryDbSnapshot<T>(
  srcPath: string,
  outPath: string,
  use: (snapshot: string, bytes: number) => T,
): T {
  assertDistinctFiles(srcPath, outPath, true);
  const dir = mkdtempSync(join(tmpdir(), "kit-memory-snapshot-"));
  try {
    const snapshot = join(dir, "memory.db");
    writeFileSync(snapshot, "", { flag: "wx", mode: 0o600 });
    const db = new DatabaseSync(srcPath, { readOnly: true });
    try {
      // SQLite reads committed WAL frames under one snapshot without migrating
      // or checkpointing the source. Keep auxiliary temporary data in memory.
      db.exec("PRAGMA busy_timeout = 5000; PRAGMA temp_store = MEMORY");
      db.prepare("VACUUM main INTO ?").run(snapshot);
    } finally {
      db.close();
    }
    return use(snapshot, statSync(snapshot).size);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function readWindow(fd: number, buffer: Buffer, length: number, position: number): number {
  let total = 0;
  while (total < length) {
    const count = readSync(fd, buffer, total, length - total, position + total);
    if (count === 0) break;
    total += count;
  }
  return total;
}

/** Compare a live store's committed SQLite snapshot with a previously decrypted backup. */
export function memoryDbMatchesSnapshot(srcPath: string, snapshotPath: string): boolean {
  return withMemoryDbSnapshot(srcPath, snapshotPath, (current) => {
    const flags = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;
    const currentFd = openSync(current, flags);
    try {
      const previousFd = openSync(snapshotPath, flags);
      try {
        const currentInfo = fstatSync(currentFd);
        const previousInfo = fstatSync(previousFd);
        if (!currentInfo.isFile() || !previousInfo.isFile()) return false;
        const size = currentInfo.size;
        if (size !== previousInfo.size) return false;
        const a = Buffer.allocUnsafe(1024 * 1024);
        const b = Buffer.allocUnsafe(1024 * 1024);
        for (let offset = 0; offset < size; offset += a.length) {
          const length = Math.min(a.length, size - offset);
          if (readWindow(currentFd, a, length, offset) !== length) return false;
          if (readWindow(previousFd, b, length, offset) !== length) return false;
          if (!a.subarray(0, length).equals(b.subarray(0, length))) return false;
        }
        return true;
      } finally {
        closeSync(previousFd);
      }
    } finally {
      closeSync(currentFd);
    }
  });
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
    const fd = openSync(inPath, "r");
    try {
      const header = Buffer.alloc(MAGIC_LEN);
      let offset = 0;
      while (offset < MAGIC_LEN) {
        const count = readSync(fd, header, offset, MAGIC_LEN - offset, offset);
        if (count === 0) return null;
        offset += count;
      }
      return header;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null; // unreadable/missing — let the caller surface a clean error
  }
}

/** True if `inPath` begins with ANY kit memory backup MAGIC header (V1/V2 passphrase
 *  or V3 public-key). Lets `kit memory sync` tell an encrypted backup from a raw .db. */
export function isEncryptedBackup(inPath: string): boolean {
  const m = magicOf(inPath);
  return (
    !!m &&
    (m.equals(MAGIC_V1) ||
      m.equals(MAGIC_V2) ||
      m.equals(MAGIC_V3) ||
      m.equals(MAGIC_V4) ||
      m.equals(MAGIC_V5))
  );
}

/** True only for a V3 (asymmetric, public-key) blob — decrypts with the local
 *  private key, never a passphrase. The branch `kit memory pull` keys off. */
export function isAsymmetricBackup(inPath: string): boolean {
  const m = magicOf(inPath);
  return !!m && (m.equals(MAGIC_V3) || m.equals(MAGIC_V5));
}

/** Encrypt a consistent SQLite snapshot of the memory DB into `outPath`. */
export function backupEncrypted(
  passphrase: string,
  srcPath: string = getMemoryDbPath(),
  outPath?: string,
): void {
  if (!outPath) throw new Error("backupEncrypted requires an output path");
  validatePassphrase(passphrase);
  const salt = randomBytes(SALT_LEN);
  const key = deriveKey(passphrase, salt, SCRYPT_V2);
  withMemoryDbSnapshot(srcPath, outPath, (snapshot, bytes) => {
    const header = Buffer.concat([MAGIC_V4, salt, sizeHeader(bytes)]);
    writeBackupFile(
      srcPath,
      outPath!,
      (fd) => writeChunkedSnapshot(fd, snapshot, header, key),
      "backup",
    );
  });
}

/** Decrypt a backup blob into `destPath`. Throws on a wrong passphrase or tampered blob (GCM auth). */
/**
 * Map a restore error to a user-facing message. Only a genuine AES-GCM auth failure (wrong key /
 * tampered ciphertext) blames the passphrase; every other cause — missing file, bad magic,
 * permissions — surfaces its real message instead of the misleading "wrong passphrase". Pure.
 */
export function restoreFailureMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return /unable to authenticate|bad[ _]decrypt|unsupported state|auth tag/i.test(msg)
    ? "wrong passphrase or corrupt backup"
    : msg;
}

export function restoreEncrypted(
  passphrase: string,
  inPath: string,
  destPath: string,
  purpose: RestorePurpose = "recovery",
): void {
  const format = magicOf(inPath);
  if (format?.equals(MAGIC_V4)) {
    assertDistinctFiles(inPath, destPath, false);
    restoreChunkedFile(
      inPath,
      MAGIC_LEN + SALT_LEN + SIZE_HEADER_LEN,
      (header) => {
        if (!header.subarray(0, MAGIC_LEN).equals(MAGIC_V4)) {
          throw new Error("not a kit memory backup (bad magic)");
        }
        return deriveKey(passphrase, header.subarray(MAGIC_LEN, MAGIC_LEN + SALT_LEN), SCRYPT_V2);
      },
      (plaintext) =>
        writeBackupFile(inPath, destPath, (fd) => copyFileToDescriptor(plaintext, fd), purpose),
    );
    return;
  }
  assertDistinctFiles(inPath, destPath, false);
  restoreLegacyFile(
    inPath,
    MAGIC_LEN + SALT_LEN + IV_LEN + TAG_LEN,
    (header) => {
      const magic = header.subarray(0, MAGIC_LEN);
      const scrypt = magic.equals(MAGIC_V2) ? SCRYPT_V2 : magic.equals(MAGIC_V1) ? undefined : null;
      if (scrypt === null) throw new Error("not a kit memory backup (bad magic)");
      const salt = header.subarray(MAGIC_LEN, MAGIC_LEN + SALT_LEN);
      const iv = header.subarray(MAGIC_LEN + SALT_LEN, MAGIC_LEN + SALT_LEN + IV_LEN);
      const tag = header.subarray(MAGIC_LEN + SALT_LEN + IV_LEN);
      return { key: deriveKey(passphrase, salt, scrypt), iv, tag };
    },
    (plaintext) =>
      writeBackupFile(inPath, destPath, (fd) => copyFileToDescriptor(plaintext, fd), purpose),
  );
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

/** Encrypt a consistent SQLite snapshot to a PUBLIC recipient key (no passphrase). */
export function backupToRecipient(
  recipient: string,
  srcPath: string = getMemoryDbPath(),
  outPath?: string,
): void {
  if (!outPath) throw new Error("backupToRecipient requires an output path");
  const recipKey = parseRecipient(recipient);
  const recipRaw = rawFromJwkComponent((recipKey.export({ format: "jwk" }) as { x: string }).x);

  const { publicKey: ephPub, privateKey: ephPriv } = generateKeyPairSync("x25519");
  const ephRaw = rawFromJwkComponent((ephPub.export({ format: "jwk" }) as { x: string }).x);
  const shared = diffieHellman({ privateKey: ephPriv, publicKey: recipKey });
  const key = deriveSharedKey(ephRaw, recipRaw, shared);
  withMemoryDbSnapshot(srcPath, outPath, (snapshot, bytes) => {
    const header = Buffer.concat([MAGIC_V5, ephRaw, sizeHeader(bytes)]);
    writeBackupFile(
      srcPath,
      outPath!,
      (fd) => writeChunkedSnapshot(fd, snapshot, header, key),
      "backup",
    );
  });
}

/** Decrypt a V3 blob with the local private key. Throws on wrong key / tamper (GCM auth). */
export function restoreWithKey(
  privateJwk: MemoryKeyJwk,
  inPath: string,
  destPath: string,
  purpose: RestorePurpose = "recovery",
): void {
  const format = magicOf(inPath);
  if (format?.equals(MAGIC_V5)) {
    assertDistinctFiles(inPath, destPath, false);
    restoreChunkedFile(
      inPath,
      MAGIC_LEN + X25519_LEN + SIZE_HEADER_LEN,
      (header) => {
        if (!header.subarray(0, MAGIC_LEN).equals(MAGIC_V5)) {
          throw new Error("not a kit public-key backup (bad magic)");
        }
        const ephRaw = header.subarray(MAGIC_LEN, MAGIC_LEN + X25519_LEN);
        const privKey = createPrivateKey({
          key: { kty: "OKP", crv: "X25519", x: privateJwk.x, d: privateJwk.d },
          format: "jwk",
        });
        const ephPub = createPublicKey({
          key: { kty: "OKP", crv: "X25519", x: ephRaw.toString("base64url") },
          format: "jwk",
        });
        const shared = diffieHellman({ privateKey: privKey, publicKey: ephPub });
        return deriveSharedKey(ephRaw, rawFromJwkComponent(privateJwk.x), shared);
      },
      (plaintext) =>
        writeBackupFile(inPath, destPath, (fd) => copyFileToDescriptor(plaintext, fd), purpose),
    );
    return;
  }
  assertDistinctFiles(inPath, destPath, false);
  restoreLegacyFile(
    inPath,
    MAGIC_LEN + X25519_LEN + IV_LEN + TAG_LEN,
    (header) => {
      if (!header.subarray(0, MAGIC_LEN).equals(MAGIC_V3)) {
        throw new Error("not a kit public-key backup (bad magic)");
      }
      const ephRaw = header.subarray(MAGIC_LEN, MAGIC_LEN + X25519_LEN);
      const iv = header.subarray(MAGIC_LEN + X25519_LEN, MAGIC_LEN + X25519_LEN + IV_LEN);
      const tag = header.subarray(MAGIC_LEN + X25519_LEN + IV_LEN);
      const privKey = createPrivateKey({
        key: { kty: "OKP", crv: "X25519", x: privateJwk.x, d: privateJwk.d },
        format: "jwk",
      });
      const ephPub = createPublicKey({
        key: { kty: "OKP", crv: "X25519", x: ephRaw.toString("base64url") },
        format: "jwk",
      });
      const shared = diffieHellman({ privateKey: privKey, publicKey: ephPub });
      return { key: deriveSharedKey(ephRaw, rawFromJwkComponent(privateJwk.x), shared), iv, tag };
    },
    (plaintext) =>
      writeBackupFile(inPath, destPath, (fd) => copyFileToDescriptor(plaintext, fd), purpose),
  );
}
