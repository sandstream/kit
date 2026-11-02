/** Publish a receipt from a checked descriptor in a trusted worktree. */
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats,
} from "node:fs";
import { join } from "node:path";
import { assertSameEntry, openReceiptForRead } from "./review-receipt-files.js";
import { isReadOnlyMode } from "./read-only-mode.js";
import { assertReviewWritable, ReviewReadOnlyRefusal } from "./review-receipt-write-guard.js";
import { sameIdentity } from "./utils/same-file.js";

type FileIdentity = { stats: BigIntStats; digest: string } | null;
const MAX_DESTINATION_BYTES = 16 * 1024 * 1024;

function destinationIdentity(path: string): FileIdentity {
  let fd: number;
  try {
    fd = openReceiptForRead(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      try {
        lstatSync(path);
      } catch (entryError) {
        if ((entryError as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw entryError;
      }
      throw new Error("review receipt destination cannot be safely opened", { cause: error });
    }
    throw error;
  }
  try {
    const opened = fstatSync(fd, { bigint: true });
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    while (true) {
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      total += count;
      if (total > MAX_DESTINATION_BYTES) throw new Error("review receipt destination is too large");
      hash.update(chunk.subarray(0, count));
    }
    assertSameEntry(fd, path);
    const final = fstatSync(fd, { bigint: true });
    if (opened.size !== BigInt(total) || final.size !== opened.size || final.nlink !== 1n)
      throw new Error("review receipt destination changed while reading");
    return { stats: opened, digest: hash.digest("hex") };
  } finally {
    closeSync(fd);
  }
}

function assertDestination(path: string, original: FileIdentity): void {
  const current = destinationIdentity(path);
  if (
    (original === null) !== (current === null) ||
    (original !== null &&
      current !== null &&
      (!sameIdentity(original.stats, current.stats) || original.digest !== current.digest))
  ) {
    throw new Error("review receipt destination changed during publication");
  }
}

function assertOwnedTemp(fd: number, path: string): void {
  const opened = fstatSync(fd, { bigint: true });
  if (!opened.isFile() || opened.nlink !== 1n)
    throw new Error("review receipt temporary file must be a regular file without hard links");
  assertSameEntry(fd, path);
}

function assertReceiptBytes(fd: number, expected: Buffer): void {
  if (fstatSync(fd).size !== expected.length) throw new Error("review receipt bytes changed");
  const actual = Buffer.alloc(expected.length);
  let offset = 0;
  while (offset < actual.length) {
    const count = readSync(fd, actual, offset, actual.length - offset, offset);
    if (count === 0) throw new Error("review receipt bytes changed");
    offset += count;
  }
  if (!actual.equals(expected)) throw new Error("review receipt bytes changed");
}

function cleanupTemp(fd: number, path: string, expected: Buffer): void {
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  assertOwnedTemp(fd, path);
  assertReceiptBytes(fd, expected);
  unlinkSync(path);
}

export function publishReviewReceipt(
  root: string,
  content: string,
  options: { afterTempWrite?: (temp: string) => void } = {},
): string {
  assertReviewWritable(root, "review-receipt-publish");
  const path = join(root, ".kit-review-receipt.json");
  const original = destinationIdentity(path);
  const temp = join(root, `.kit-review-receipt.json.${randomBytes(16).toString("hex")}.tmp`);
  const flags =
    constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
  const fd = openSync(temp, flags, 0o600);
  const expected = Buffer.from(content, "utf8");
  let failure: unknown;
  try {
    assertOwnedTemp(fd, temp);
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
    options.afterTempWrite?.(temp);
    assertReviewWritable(root, "review-receipt-publish");
    assertOwnedTemp(fd, temp);
    assertReceiptBytes(fd, expected);
    assertDestination(path, original);
    renameSync(temp, path);
    assertOwnedTemp(fd, path);
    assertReceiptBytes(fd, expected);
  } catch (error) {
    failure = error;
  }
  try {
    if (isReadOnlyMode()) {
      if (!(failure instanceof ReviewReadOnlyRefusal))
        assertReviewWritable(root, "review-receipt-publish");
    } else {
      cleanupTemp(fd, temp, expected);
    }
  } catch (error) {
    failure =
      failure === undefined
        ? error
        : new AggregateError([failure, error], "review receipt publication and cleanup failed");
  } finally {
    closeSync(fd);
  }
  if (failure !== undefined) throw failure;
  return path;
}
