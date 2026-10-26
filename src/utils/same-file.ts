// File identity by device and inode, read as bigint.
//
// On Windows `Stats.ino` is a 64-bit (NTFS) or 128-bit (ReFS) file id squeezed into a double.
// Ids above 2^53 lose their low bits, so two different files can compare equal; some
// filesystems report 0 for every file. Both make an identity check claim "same file" for
// files that are not. Bigint stats keep the full id, and an id of 0 never matches.
import { statSync, type BigIntStats } from "node:fs";

/** The bigint stats of `path`, or undefined when it does not exist. */
export function identityOf(path: string): BigIntStats | undefined {
  return statSync(path, { bigint: true, throwIfNoEntry: false });
}

/** True only when both exist and carry the same non-zero device and inode. */
export function sameIdentity(a: BigIntStats | undefined, b: BigIntStats | undefined): boolean {
  return !!a && !!b && a.ino !== 0n && a.dev === b.dev && a.ino === b.ino;
}
