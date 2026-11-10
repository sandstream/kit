import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export function canonicalAuditLogPath(path: string): string {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (!entry) return join(realpathSync(dirname(path)), basename(path));
  const canonical = realpathSync(path);
  const stat = lstatSync(canonical);
  if (!stat.isFile() || stat.nlink !== 1) {
    throw new Error("The audit log must be a regular file with one link.");
  }
  return canonical;
}
