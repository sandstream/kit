/** Bounded streaming codecs shared by the memory backup formats. */
import { createDecipheriv, createCipheriv, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  fchmodSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";

const IV_LEN = 12;
const TAG_LEN = 16;
const FRAME_HEADER_LEN = 8 + IV_LEN + TAG_LEN;
export const CHUNK_BYTES = 1024 * 1024;
export const SIZE_HEADER_LEN = 12;
export const MAX_DECOMPRESSED_BYTES = 1024 * 1024 * 1024;

export type LegacyKeyMaterial = { key: Buffer; iv: Buffer; tag: Buffer };

export function copyFileToDescriptor(path: string, output: number): void {
  const input = openSync(path, "r");
  const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
  try {
    for (;;) {
      const count = readSync(input, chunk, 0, chunk.length, null);
      if (!count) return;
      writeFileSync(output, chunk.subarray(0, count));
    }
  } finally {
    closeSync(input);
  }
}

export function sizeHeader(bytes: number): Buffer {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_DECOMPRESSED_BYTES) {
    throw new Error("memory snapshot exceeds the 1024 MB backup limit");
  }
  const header = Buffer.alloc(SIZE_HEADER_LEN);
  header.writeBigUInt64BE(BigInt(bytes), 0);
  header.writeUInt32BE(Math.ceil(bytes / CHUNK_BYTES), 8);
  return header;
}

function chunkAad(header: Buffer, index: number, frame: Buffer): Buffer {
  const position = Buffer.alloc(4);
  position.writeUInt32BE(index);
  return Buffer.concat([header, position, frame.subarray(0, 8)]);
}

export function writeChunkedSnapshot(
  output: number,
  snapshot: string,
  header: Buffer,
  key: Buffer,
): void {
  writeFileSync(output, header);
  const input = openSync(snapshot, "r");
  const source = Buffer.allocUnsafe(CHUNK_BYTES);
  let index = 0;
  try {
    for (;;) {
      const count = readSync(input, source, 0, source.length, null);
      if (!count) break;
      const compressed = gzipSync(source.subarray(0, count));
      const iv = randomBytes(IV_LEN);
      const frame = Buffer.alloc(FRAME_HEADER_LEN);
      frame.writeUInt32BE(compressed.length, 0);
      frame.writeUInt32BE(count, 4);
      iv.copy(frame, 8);
      const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_LEN });
      cipher.setAAD(chunkAad(header, index++, frame));
      const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
      cipher.getAuthTag().copy(frame, 8 + IV_LEN);
      writeFileSync(output, frame);
      writeFileSync(output, ciphertext);
    }
  } finally {
    closeSync(input);
  }
}

function readExact(fd: number, bytes: number, label: string): Buffer {
  const value = Buffer.allocUnsafe(bytes);
  let offset = 0;
  while (offset < bytes) {
    const count = readSync(fd, value, offset, bytes - offset, null);
    if (!count) throw new Error(`truncated ${label}`);
    offset += count;
  }
  return value;
}

function chunkedSize(header: Buffer): { bytes: number; chunks: number } {
  const offset = header.length - SIZE_HEADER_LEN;
  const raw = header.readBigUInt64BE(offset);
  if (raw > BigInt(MAX_DECOMPRESSED_BYTES)) {
    throw new Error("backup decompresses beyond the 1024 MB limit — refusing (possible gzip bomb)");
  }
  const bytes = Number(raw);
  const chunks = header.readUInt32BE(offset + 8);
  if (chunks !== Math.ceil(bytes / CHUNK_BYTES)) throw new Error("invalid chunked backup size");
  return { bytes, chunks };
}

function decryptChunks(input: number, output: number, header: Buffer, key: Buffer): void {
  const size = chunkedSize(header);
  let restored = 0;
  for (let index = 0; index < size.chunks; index++) {
    const frame = readExact(input, FRAME_HEADER_LEN, "backup frame");
    const encryptedBytes = frame.readUInt32BE(0);
    const rawBytes = frame.readUInt32BE(4);
    const expectedRaw = Math.min(CHUNK_BYTES, size.bytes - restored);
    if (!encryptedBytes || encryptedBytes > CHUNK_BYTES + 64 * 1024 || rawBytes !== expectedRaw) {
      throw new Error("invalid chunked backup frame");
    }
    const ciphertext = readExact(input, encryptedBytes, "backup ciphertext");
    const iv = frame.subarray(8, 8 + IV_LEN);
    const tag = frame.subarray(8 + IV_LEN);
    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_LEN });
    decipher.setAAD(chunkAad(header, index, frame));
    decipher.setAuthTag(tag);
    const compressed = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    let plaintext: Buffer;
    try {
      plaintext = gunzipSync(compressed, { maxOutputLength: rawBytes });
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      throw new Error("invalid chunked backup frame: decompressed chunk exceeds its limit", {
        cause: error,
      });
    }
    if (plaintext.length !== rawBytes) throw new Error("invalid chunked backup frame size");
    writeFileSync(output, plaintext);
    restored += plaintext.length;
  }
  if (restored !== size.bytes) throw new Error("truncated chunked backup");
  const extra = Buffer.alloc(1);
  if (readSync(input, extra, 0, 1, null)) throw new Error("trailing bytes after chunked backup");
}

export function restoreChunkedFile(
  inPath: string,
  headerBytes: number,
  keyFor: (header: Buffer) => Buffer,
  publish: (plaintext: string) => void,
): void {
  const dir = mkdtempSync(join(tmpdir(), "kit-memory-restore-"));
  try {
    chmodSync(dir, 0o700);
    const plaintext = join(dir, "memory.db");
    const output = openSync(plaintext, "wx", 0o600);
    try {
      fchmodSync(output, 0o600);
      const input = openSync(inPath, "r");
      try {
        const header = readExact(input, headerBytes, "backup header");
        decryptChunks(input, output, header, keyFor(header));
      } finally {
        closeSync(input);
      }
    } finally {
      closeSync(output);
    }
    publish(plaintext);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const LEGACY_GUNZIP_SCRIPT = String.raw`
import { createReadStream, createWriteStream, rmSync } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

const [source, destination, rawLimit] = process.argv.slice(1);
const limit = Number(rawLimit);
let bytes = 0;
const bounded = new Transform({
  transform(chunk, _encoding, callback) {
    bytes += chunk.length;
    callback(bytes > limit ? new Error("KIT_MEMORY_DECOMPRESS_LIMIT") : null, chunk);
  },
});

try {
  await pipeline(
    createReadStream(source),
    createGunzip(),
    bounded,
    createWriteStream(destination, { flags: "wx", mode: 0o600 }),
  );
} catch (error) {
  rmSync(destination, { force: true });
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
`;

function gunzipLegacyFile(source: string, destination: string): void {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      LEGACY_GUNZIP_SCRIPT,
      source,
      destination,
      String(MAX_DECOMPRESSED_BYTES),
    ],
    { encoding: "utf8", stdio: ["ignore", "ignore", "pipe"], maxBuffer: 256 * 1024 },
  );
  if (result.error) throw result.error;
  if (result.status === 0) return;
  if (result.stderr.includes("KIT_MEMORY_DECOMPRESS_LIMIT")) {
    throw new Error("backup decompresses beyond the 1024 MB limit — refusing (possible gzip bomb)");
  }
  throw new Error(`could not decompress legacy backup: ${result.stderr.trim() || "invalid gzip"}`);
}

function decryptLegacyFile(
  input: number,
  output: number,
  headerBytes: number,
  keyFor: (header: Buffer) => LegacyKeyMaterial,
): void {
  const header = readExact(input, headerBytes, "legacy backup header");
  const { key, iv, tag } = keyFor(header);
  const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_LEN });
  decipher.setAuthTag(tag);
  const encrypted = Buffer.allocUnsafe(CHUNK_BYTES);
  let bytes = 0;
  for (;;) {
    const count = readSync(input, encrypted, 0, encrypted.length, null);
    if (!count) break;
    const plaintext = decipher.update(encrypted.subarray(0, count));
    bytes += plaintext.length;
    if (bytes > MAX_DECOMPRESSED_BYTES) {
      throw new Error("legacy backup plaintext exceeds the 1024 MB limit");
    }
    if (plaintext.length) writeFileSync(output, plaintext);
  }
  const final = decipher.final();
  if (bytes + final.length > MAX_DECOMPRESSED_BYTES) {
    throw new Error("legacy backup plaintext exceeds the 1024 MB limit");
  }
  if (final.length) writeFileSync(output, final);
}

function isGzipFile(path: string): boolean {
  const input = openSync(path, "r");
  try {
    const magic = Buffer.alloc(2);
    return (
      readSync(input, magic, 0, magic.length, 0) === 2 && magic[0] === 0x1f && magic[1] === 0x8b
    );
  } finally {
    closeSync(input);
  }
}

export function restoreLegacyFile(
  inPath: string,
  headerBytes: number,
  keyFor: (header: Buffer) => LegacyKeyMaterial,
  publish: (plaintext: string) => void,
): void {
  const dir = mkdtempSync(join(tmpdir(), "kit-memory-legacy-restore-"));
  try {
    chmodSync(dir, 0o700);
    const decrypted = join(dir, "decrypted");
    const input = openSync(inPath, "r");
    try {
      const output = openSync(decrypted, "wx", 0o600);
      try {
        fchmodSync(output, 0o600);
        decryptLegacyFile(input, output, headerBytes, keyFor);
      } finally {
        closeSync(output);
      }
    } finally {
      closeSync(input);
    }
    const plaintext = isGzipFile(decrypted) ? join(dir, "memory.db") : decrypted;
    if (plaintext !== decrypted) gunzipLegacyFile(decrypted, plaintext);
    publish(plaintext);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
