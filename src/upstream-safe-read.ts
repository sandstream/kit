/**
 * Reads of files that come from the repository being inspected. A repository is untrusted input:
 * a symlinked lockfile or `.kit.toml` could point at any file the user can read, and a parser error
 * message can quote the text it choked on. So these reads refuse symlinks and non-regular files,
 * cap the size, and throw only fixed messages that never contain file content.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";

const MAX_BYTES = 8 * 1024 * 1024;

/**
 * The file's text, or null when it does not exist. Throws a fixed-message error otherwise.
 * The checks run on the open descriptor, not on the path, so the file cannot be swapped for a
 * symlink between the check and the read. `O_NOFOLLOW` makes the open itself refuse a symlink
 * where the platform has it, and the folder-level `lstat` gives the clear message everywhere.
 */
export function readRegularFileIfPresent(path: string): string | null {
  let linkStat;
  try {
    linkStat = lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("could not be read", { cause: err });
  }
  if (linkStat.isSymbolicLink()) throw new Error("is a symlink, not read");
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ELOOP") throw new Error("is a symlink, not read", { cause: err });
    throw new Error("could not be read", { cause: err });
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("is not a regular file");
    if (stat.size > MAX_BYTES) throw new Error("is too large to read");
    if (stat.ino !== linkStat.ino || stat.dev !== linkStat.dev)
      throw new Error("changed while it was read");
    return readFileSync(fd, "utf-8");
  } finally {
    closeSync(fd);
  }
}

/** True when something (file, symlink or folder) exists at `path`. Reads no content. */
export function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
