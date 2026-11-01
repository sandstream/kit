/** Open receipt files without following a replaced link. */
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  openSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { isReadOnlyMode } from "./read-only-mode.js";
import { assertReviewWritable, ReviewReadOnlyRefusal } from "./review-receipt-write-guard.js";
import { sameIdentity } from "./utils/same-file.js";

const noFollow = constants.O_NOFOLLOW ?? 0;
const nonBlock = constants.O_NONBLOCK ?? 0;

export function assertSameEntry(fd: number, path: string): void {
  const opened = fstatSync(fd, { bigint: true });
  const entry = lstatSync(path, { bigint: true });
  if (!opened.isFile() || !entry.isFile() || !sameIdentity(opened, entry)) {
    throw new Error("review receipt file changed while opening");
  }
}

/** Decode only valid UTF-8, so malformed bytes cannot be normalised into signed text. */
export function decodeReceiptUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

function checkOpenedFile(fd: number, path: string): void {
  const opened = fstatSync(fd, { bigint: true });
  if (!opened.isFile() || opened.nlink !== 1n) {
    throw new Error("review receipt file must be a regular file without hard links");
  }
  assertSameEntry(fd, path);
}

function validateHandle(fd: number, path: string, afterOpen?: () => void): number {
  try {
    afterOpen?.();
    checkOpenedFile(fd, path);
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

export function openReceiptForRead(
  path: string,
  noFollowFlag = noFollow,
  afterOpen?: () => void,
): number {
  const fd = openSync(path, constants.O_RDONLY | noFollowFlag | nonBlock);
  return validateHandle(fd, path, afterOpen);
}

function unlinkOwnedTemp(fd: number, path: string): void {
  assertSameEntry(fd, path);
  unlinkSync(path);
}

/** Publish a new file without opening the destination with a create flag. */
function createHistory(path: string, flags: number, publish: typeof linkSync): number {
  const temp = join(dirname(path), `.kit-receipt-${randomBytes(16).toString("hex")}.tmp`);
  const fd = openSync(temp, flags | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    try {
      publish(temp, path);
      assertReviewWritable(dirname(path), "review-history");
      assertSameEntry(fd, path);
    } catch (error) {
      if (isReadOnlyMode()) {
        if (error instanceof ReviewReadOnlyRefusal) throw error;
        assertReviewWritable(dirname(path), "review-history");
      }
      try {
        unlinkOwnedTemp(fd, temp);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "review history publication and cleanup failed",
          { cause: cleanupError },
        );
      }
      throw error;
    }
    try {
      unlinkOwnedTemp(fd, temp);
    } catch (error) {
      throw new Error("review history temporary file cleanup failed", { cause: error });
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/** Open without creating, or publish a new file without following the destination. */
function openHistoryForAppend(
  path: string,
  noFollowFlag: number,
  afterOpen: (() => void) | undefined,
  publish: typeof linkSync,
): number {
  const flags = constants.O_WRONLY | constants.O_APPEND | noFollowFlag | nonBlock;
  let fd: number;
  try {
    fd = openSync(path, flags);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      fd = createHistory(path, flags, publish);
    } catch (createError) {
      if ((createError as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error("review history changed while creating it; retry the operation", {
          cause: createError,
        });
      }
      throw createError;
    }
  }
  return validateHandle(fd, path, afterOpen);
}

interface AppendReceiptHistoryOptions {
  noFollowFlag?: number;
  afterOpen?: () => void;
  publish?: typeof linkSync;
  write?: (fd: number, text: string) => void;
}

export function appendReceiptHistory(
  path: string,
  text: string,
  options: AppendReceiptHistoryOptions = {},
): void {
  assertReviewWritable(dirname(path), "review-history");
  const fd = openHistoryForAppend(
    path,
    options.noFollowFlag ?? noFollow,
    options.afterOpen,
    options.publish ?? linkSync,
  );
  try {
    assertReviewWritable(dirname(path), "review-history");
    const write = options.write ?? ((handle, data) => writeFileSync(handle, data, "utf8"));
    write(fd, text);
  } finally {
    closeSync(fd);
  }
}
