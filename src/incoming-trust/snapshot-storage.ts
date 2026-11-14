import { lstatSync, mkdirSync, realpathSync, rmSync, type BigIntStats } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { privateDirIsControlled, secureDirStrict } from "../utils/secure-perms.js";
import { sameIdentity } from "../utils/same-file.js";

export function removeOwnedSnapshot(path: string, identity: BigIntStats): void {
  if (sameIdentity(identity, lstatSync(path, { bigint: true, throwIfNoEntry: false })))
    rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
}

export function containsSnapshotPath(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

export function prepareSnapshot(source: string, destination: string) {
  if (!isAbsolute(source) || !isAbsolute(destination))
    throw new Error("Incoming snapshot: invalid-path");
  const sourceRoot = realpathSync(source);
  if (!lstatSync(sourceRoot).isDirectory()) throw new Error("Incoming snapshot: invalid-source");
  const parent = dirname(destination);
  if (!lstatSync(parent).isDirectory() || !privateDirIsControlled(parent))
    throw new Error("Incoming snapshot: uncontrolled-destination");
  const target = join(realpathSync(parent), basename(destination));
  if (containsSnapshotPath(sourceRoot, target) || containsSnapshotPath(target, sourceRoot))
    throw new Error("Incoming snapshot: overlapping-paths");
  if (lstatSync(target, { throwIfNoEntry: false }))
    throw new Error("Incoming snapshot: destination-exists");
  mkdirSync(target, { mode: 0o700 });
  const identity = lstatSync(target, { bigint: true });
  try {
    secureDirStrict(target);
    return { source: sourceRoot, destination: target, identity };
  } catch (error) {
    removeOwnedSnapshot(target, identity);
    throw error;
  }
}
