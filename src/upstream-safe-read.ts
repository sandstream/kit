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
 * The file is opened first and every check runs on the open descriptor, never on the path, so it
 * cannot be swapped between a check and the read. `O_NOFOLLOW` makes the open itself refuse a
 * symlink and `O_NONBLOCK` keeps a named pipe from waiting for a writer, where the platform has
 * them. Where it has no `O_NOFOLLOW` (Windows) the opened file is compared with the path's own
 * entry afterwards, and the read still goes through the descriptor.
 */
export function readRegularFileIfPresent(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "ELOOP") throw new Error("is a symlink, not read", { cause: err });
    throw new Error("could not be read", { cause: err });
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("is not a regular file");
    if (stat.size > MAX_BYTES) throw new Error("is too large to read");
    if (constants.O_NOFOLLOW === undefined) rejectLink(path, stat);
    return readFileSync(fd, "utf-8");
  } finally {
    closeSync(fd);
  }
}

/** Without `O_NOFOLLOW`: refuse when the path is a link or no longer names the file that was opened. */
function rejectLink(path: string, opened: { ino: number; dev: number }): void {
  const entry = lstatSync(path);
  if (entry.isSymbolicLink()) throw new Error("is a symlink, not read");
  if (entry.ino !== opened.ino || entry.dev !== opened.dev)
    throw new Error("changed while it was read");
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
