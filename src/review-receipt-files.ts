/** Open receipt files without following a replaced link. */
import { closeSync, constants, fstatSync, lstatSync, openSync, writeFileSync } from "node:fs";

const noFollow = constants.O_NOFOLLOW ?? 0;
const nonBlock = constants.O_NONBLOCK ?? 0;

function checkOpenedFile(fd: number, path: string, noFollowFlag: number): void {
  const opened = fstatSync(fd, { bigint: true });
  if (!opened.isFile() || opened.nlink !== 1n) {
    throw new Error("review receipt file must be a regular file without hard links");
  }
  // Windows may not expose O_NOFOLLOW. Compare the entry with the open handle
  // before any read or write, and then use only that handle for the operation.
  if (!noFollowFlag) {
    const entry = lstatSync(path, { bigint: true });
    if (
      !entry.isFile() ||
      entry.nlink !== 1n ||
      opened.ino === 0n ||
      entry.dev !== opened.dev ||
      entry.ino !== opened.ino
    ) {
      throw new Error("review receipt file changed while opening");
    }
  }
}

function validateHandle(
  fd: number,
  path: string,
  noFollowFlag: number,
  afterOpen?: () => void,
): number {
  try {
    afterOpen?.();
    checkOpenedFile(fd, path, noFollowFlag);
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
  return validateHandle(fd, path, noFollowFlag, afterOpen);
}

/** Create exclusively or open without creating; neither can follow a dangling link. */
function openHistoryForAppend(path: string, noFollowFlag: number, afterOpen?: () => void): number {
  const flags = constants.O_WRONLY | constants.O_APPEND | noFollowFlag | nonBlock;
  let fd: number;
  try {
    fd = openSync(path, flags | constants.O_CREAT | constants.O_EXCL, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    fd = openSync(path, flags);
  }
  return validateHandle(fd, path, noFollowFlag, afterOpen);
}

export function appendReceiptHistory(
  path: string,
  text: string,
  noFollowFlag = noFollow,
  afterOpen?: () => void,
): void {
  const fd = openHistoryForAppend(path, noFollowFlag, afterOpen);
  try {
    writeFileSync(fd, text, { encoding: "utf8" });
  } finally {
    closeSync(fd);
  }
}
