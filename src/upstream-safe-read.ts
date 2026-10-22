/**
 * Reads of files that come from the repository being inspected. A repository is untrusted input:
 * a symlinked lockfile or `.kit.toml` could point at any file the user can read, and a parser error
 * message can quote the text it choked on. So these reads refuse symlinks and non-regular files,
 * cap the size, and throw only fixed messages that never contain file content.
 */
import { lstatSync, readFileSync } from "node:fs";

const MAX_BYTES = 8 * 1024 * 1024;

/** The file's text, or null when it does not exist. Throws a fixed-message error otherwise. */
export function readRegularFileIfPresent(path: string): string | null {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("could not be read", { cause: err });
  }
  if (stat.isSymbolicLink()) throw new Error("is a symlink, not read");
  if (!stat.isFile()) throw new Error("is not a regular file");
  if (stat.size > MAX_BYTES) throw new Error("is too large to read");
  try {
    return readFileSync(path, "utf-8");
  } catch (err) {
    throw new Error("could not be read", { cause: err });
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
