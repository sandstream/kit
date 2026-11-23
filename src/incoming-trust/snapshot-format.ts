import { createHash } from "node:crypto";

export type IncomingSnapshotEntry =
  | { path: string; kind: "directory" }
  | { path: string; kind: "symlink"; target: string }
  | { path: string; kind: "file"; size: number; sha256: string; executable: boolean };

export function snapshotEntryBytes(
  entry: IncomingSnapshotEntry,
  hasPreviousEntry: boolean,
): number {
  return Buffer.byteLength(JSON.stringify(entry)) + (hasPreviousEntry ? 1 : 0);
}

export function snapshotManifest(entries: IncomingSnapshotEntry[], maxBytes: number): string {
  const manifest = JSON.stringify({ schema: "kit.incoming-snapshot", version: 1, entries });
  if (Buffer.byteLength(manifest) > maxBytes) throw new Error("Incoming snapshot: manifest-limit");
  return manifest;
}

export function snapshotDigest(manifest: string): string {
  return createHash("sha256").update(manifest).digest("hex");
}
