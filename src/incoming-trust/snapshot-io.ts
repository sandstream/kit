import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  writeSync,
  type BigIntStats,
} from "node:fs";
import { sameIdentity } from "../utils/same-file.js";
import { secureFileStrict } from "../utils/secure-perms.js";

export function unchanged(before: BigIntStats, after: BigIntStats): boolean {
  return (
    sameIdentity(before, after) &&
    before.mode === after.mode &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs &&
    before.nlink === after.nlink
  );
}

export function readSnapshotFile(
  source: string,
  expected: BigIntStats,
  maxBytes: number,
  consume?: (chunk: Buffer) => void,
) {
  if (!expected.isFile()) throw new Error("Incoming snapshot: unsupported-file");
  if (expected.size > BigInt(maxBytes)) throw new Error("Incoming snapshot: input-limit");
  // Open an existing file only. The mode is ignored without O_CREAT.
  const input = openSync(
    source,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    0o600,
  );
  try {
    if (!unchanged(expected, fstatSync(input, { bigint: true })))
      throw new Error("Incoming snapshot: source-changed");
    const executable = (expected.mode & 0o111n) !== 0n;
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let size = 0;
    while (size <= Number(expected.size)) {
      const count = readSync(
        input,
        buffer,
        0,
        Math.min(buffer.length, Number(expected.size) + 1 - size),
        null,
      );
      if (count === 0) break;
      size += count;
      if (size > Number(expected.size)) throw new Error("Incoming snapshot: source-changed");
      hash.update(buffer.subarray(0, count));
      consume?.(buffer.subarray(0, count));
    }
    if (
      size !== Number(expected.size) ||
      !unchanged(expected, fstatSync(input, { bigint: true })) ||
      !unchanged(expected, lstatSync(source, { bigint: true }))
    )
      throw new Error("Incoming snapshot: source-changed");
    return { size, sha256: hash.digest("hex"), executable };
  } finally {
    closeSync(input);
  }
}

export function copySnapshotFile(
  source: string,
  destination: string,
  expected: BigIntStats,
  maxBytes: number,
) {
  const mode = (expected.mode & 0o111n) !== 0n ? 0o700 : 0o600;
  const output = openSync(
    destination,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    mode,
  );
  try {
    const result = readSnapshotFile(source, expected, maxBytes, (chunk) => {
      let written = 0;
      while (written < chunk.length) {
        const count = writeSync(output, chunk, written, chunk.length - written);
        if (count === 0) throw new Error("Incoming snapshot: failed-write");
        written += count;
      }
    });
    if (process.platform === "win32") secureFileStrict(destination);
    return result;
  } finally {
    closeSync(output);
  }
}

export function readSnapshotBytes(path: string, info: BigIntStats, maxBytes: number): Buffer {
  const chunks: Buffer[] = [];
  readSnapshotFile(path, info, maxBytes, (chunk) => chunks.push(Buffer.from(chunk)));
  return Buffer.concat(chunks);
}

export function readSnapshotManifest(path: string, maxBytes: number): string {
  const info = lstatSync(path, { bigint: true });
  if (info.size > BigInt(maxBytes)) throw new Error("Incoming snapshot: manifest-limit");
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    readSnapshotBytes(path, info, maxBytes),
  );
}
