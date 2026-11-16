import { createHash } from "node:crypto";

export type IncomingSnapshotEntry =
  | { path: string; kind: "directory" }
  | { path: string; kind: "symlink"; target: string }
  | { path: string; kind: "file"; size: number; sha256: string; executable: boolean };

export function snapshotManifest(entries: IncomingSnapshotEntry[], maxBytes: number): string {
  const manifest = JSON.stringify({ schema: "kit.incoming-snapshot", version: 1, entries });
  if (Buffer.byteLength(manifest) > maxBytes) throw new Error("Incoming snapshot: manifest-limit");
  return manifest;
}

export function snapshotDigest(manifest: string): string {
  return createHash("sha256").update(manifest).digest("hex");
}
