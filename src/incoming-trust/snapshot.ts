import { lstatSync, opendirSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { isReadOnlyMode } from "../read-only-mode.js";
import { secureFileStrict } from "../utils/secure-perms.js";
import { prepareSnapshot, removeOwnedSnapshot } from "./snapshot-storage.js";
import { assertPrivateEntry, captureTree } from "./snapshot-tree.js";
import { readSnapshotManifest, unchanged } from "./snapshot-io.js";
import { snapshotLimits, type IncomingSnapshotLimits } from "./snapshot-limits.js";
import { snapshotManifest, snapshotDigest } from "./snapshot-format.js";

export type { IncomingSnapshotLimits } from "./snapshot-limits.js";

export interface IncomingSnapshot {
  digest: string;
  tree: string;
  files: number;
  bytes: number;
}

function expectedLayout(path: string): boolean {
  const directory = opendirSync(path);
  try {
    const names: string[] = [];
    for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
      names.push(entry.name);
      if (names.length > 2) return false;
    }
    return JSON.stringify(names.sort()) === '["manifest.json","tree"]';
  } finally {
    directory.closeSync();
  }
}

export function verifyIncomingSnapshot(
  destination: string,
  expectedDigest: string,
  options?: Partial<IncomingSnapshotLimits>,
): { ok: boolean } {
  if (typeof expectedDigest !== "string" || !/^[a-f0-9]{64}$/.test(expectedDigest))
    return { ok: false };
  try {
    const limits = snapshotLimits(options);
    if (!isAbsolute(destination)) return { ok: false };
    const root = lstatSync(destination, { bigint: true });
    if (!root.isDirectory()) return { ok: false };
    assertPrivateEntry(destination, root);
    if (!expectedLayout(destination)) return { ok: false };
    const path = join(destination, "manifest.json");
    const manifestInfo = lstatSync(path, { bigint: true });
    assertPrivateEntry(path, manifestInfo);
    const manifest = readSnapshotManifest(path, limits.maxManifestBytes);
    if (snapshotDigest(manifest) !== expectedDigest) return { ok: false };
    const actual = captureTree(join(destination, "tree"), limits);
    return {
      ok:
        snapshotManifest(actual.entries, limits.maxManifestBytes) === manifest &&
        unchanged(root, lstatSync(destination, { bigint: true })) &&
        unchanged(manifestInfo, lstatSync(path, { bigint: true })),
    };
  } catch {
    return { ok: false };
  }
}

export function captureIncomingSnapshot(
  source: string,
  destination: string,
  options?: Partial<IncomingSnapshotLimits>,
): IncomingSnapshot {
  if (isReadOnlyMode()) throw new Error("Incoming snapshot: read-only");
  const limits = snapshotLimits(options);
  const prepared = prepareSnapshot(source, destination);
  try {
    const tree = join(prepared.destination, "tree");
    const captured = captureTree(prepared.source, limits, tree);
    const manifest = snapshotManifest(captured.entries, limits.maxManifestBytes);
    const digest = snapshotDigest(manifest);
    const path = join(prepared.destination, "manifest.json");
    writeFileSync(path, manifest, { flag: "wx", mode: 0o600 });
    secureFileStrict(path);
    if (!verifyIncomingSnapshot(prepared.destination, digest, limits).ok)
      throw new Error("Incoming snapshot: copy-verification-failed");
    return { digest, tree, files: captured.files, bytes: captured.bytes };
  } catch (error) {
    removeOwnedSnapshot(prepared.destination, prepared.identity);
    throw error;
  }
}
