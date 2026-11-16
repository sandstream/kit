import { readlinkSync, realpathSync } from "node:fs";
import { dirname, posix } from "node:path";
import { containsSnapshotPath } from "./snapshot-storage.js";

function assertLinkResolution(root: string, source: string, target: string): void {
  // Preserve '..' for native resolution; path.join would erase traversal through aliases.
  let current = `${dirname(source)}/${target}`;
  while (current) {
    try {
      if (!containsSnapshotPath(root, realpathSync.native(current))) throw new Error("outside");
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR")
        throw new Error("Incoming snapshot: unsupported-link", { cause: error });
      current = current.slice(0, current.lastIndexOf("/"));
    }
  }
  throw new Error("Incoming snapshot: unsupported-link");
}

export function readSnapshotLink(
  root: string,
  source: string,
  path: string,
  maxBytes: number,
): string {
  if (process.platform === "win32") throw new Error("Incoming snapshot: unsupported-link");
  const raw = readlinkSync(source, { encoding: "buffer" });
  if (raw.length > maxBytes) throw new Error("Incoming snapshot: input-limit");
  const target = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
  if (
    !target ||
    target.includes("\\") ||
    /^[a-zA-Z]:/.test(target) ||
    posix.isAbsolute(target) ||
    !Buffer.from(target).equals(raw)
  )
    throw new Error("Incoming snapshot: unsupported-link");
  const normalized = posix.normalize(posix.join(posix.dirname(path), target));
  if (normalized === ".." || normalized.startsWith("../"))
    throw new Error("Incoming snapshot: unsupported-link");
  assertLinkResolution(root, source, target);
  return target;
}
