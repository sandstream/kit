import {
  lstatSync,
  mkdirSync,
  opendirSync,
  realpathSync,
  symlinkSync,
  type BigIntStats,
} from "node:fs";
import { join } from "node:path";
import {
  secureDirStrict,
  privateDirIsControlled,
  privateFileIsControlled,
} from "../utils/secure-perms.js";
import { copySnapshotFile, readSnapshotFile, unchanged } from "./snapshot-io.js";
import { snapshotManifest, type IncomingSnapshotEntry } from "./snapshot-format.js";
import type { IncomingSnapshotLimits } from "./snapshot-limits.js";
import { readSnapshotLink } from "./snapshot-links.js";

interface Capture {
  root: string;
  entries: IncomingSnapshotEntry[];
  observations: { path: string; info: BigIntStats }[];
  files: number;
  bytes: number;
  limits: IncomingSnapshotLimits;
  manifestBytes: number;
  discovered: number;
  nameBytes: number;
}

function boundedNames(source: string, state: Capture): string[] {
  // Latin-1 retains each filename byte; fatal UTF-8 decode below refuses lossy paths.
  const directory = opendirSync(source, { encoding: "latin1", bufferSize: 1 });
  const names: Buffer[] = [];
  try {
    for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
      const raw = Buffer.from(entry.name, "latin1");
      state.discovered++;
      state.nameBytes += raw.length;
      if (
        state.discovered > state.limits.maxEntries ||
        state.nameBytes > state.limits.maxManifestBytes
      )
        throw new Error("Incoming snapshot: input-limit");
      names.push(raw);
    }
  } finally {
    directory.closeSync();
  }
  return names.sort(Buffer.compare).map((raw) => {
    const name = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
    if (name.includes("\\") || !Buffer.from(name).equals(raw))
      throw new Error("Incoming snapshot: unsupported-name");
    return name;
  });
}

function addEntry(state: Capture, entry: IncomingSnapshotEntry): void {
  state.manifestBytes += Buffer.byteLength(JSON.stringify(entry)) + (state.entries.length ? 1 : 0);
  if (state.manifestBytes > state.limits.maxManifestBytes)
    throw new Error("Incoming snapshot: manifest-limit");
  state.entries.push(entry);
}

function walk(
  source: string,
  destination: string | undefined,
  path: string,
  state: Capture,
  depth: number,
): void {
  if (
    depth > state.limits.maxDepth ||
    state.entries.length >= state.limits.maxEntries ||
    Buffer.byteLength(path) > state.limits.maxPathBytes
  )
    throw new Error("Incoming snapshot: input-limit");
  const info = lstatSync(source, { bigint: true });
  if (destination === undefined) assertPrivateEntry(source, info);
  state.observations.push({ path: source, info });
  if (info.isDirectory()) {
    if (destination !== undefined) {
      mkdirSync(destination, { mode: 0o700 });
      secureDirStrict(destination);
    }
    addEntry(state, { path, kind: "directory" });
    for (const name of boundedNames(source, state)) {
      walk(
        join(source, name),
        destination === undefined ? undefined : join(destination, name),
        path ? `${path}/${name}` : name,
        state,
        depth + 1,
      );
    }
  } else if (info.isSymbolicLink()) {
    const target = readSnapshotLink(state.root, source, path, state.limits.maxPathBytes);
    if (destination !== undefined) symlinkSync(target, destination);
    addEntry(state, { path, kind: "symlink", target });
  } else {
    if (info.size > BigInt(state.limits.maxBytes - state.bytes))
      throw new Error("Incoming snapshot: input-limit");
    const file =
      destination === undefined
        ? readSnapshotFile(source, info, state.limits.maxFileBytes)
        : copySnapshotFile(source, destination, info, state.limits.maxFileBytes);
    addEntry(state, { path, kind: "file", ...file });
    state.files++;
    state.bytes += file.size;
  }
  if (!unchanged(info, lstatSync(source, { bigint: true })))
    throw new Error("Incoming snapshot: source-changed");
}

export function assertPrivateEntry(path: string, info: BigIntStats): void {
  if (info.isSymbolicLink()) {
    if (process.platform === "win32" || info.uid !== BigInt(process.getuid!()))
      throw new Error("Incoming snapshot: uncontrolled-copy");
    return;
  }
  const controlled = info.isDirectory()
    ? privateDirIsControlled(path)
    : info.isFile() && info.nlink === 1n && privateFileIsControlled(path);
  if (!controlled || (process.platform !== "win32" && (info.mode & 0o077n) !== 0n))
    throw new Error("Incoming snapshot: uncontrolled-copy");
}

export function captureTree(source: string, limits: IncomingSnapshotLimits, destination?: string) {
  if (!lstatSync(source).isDirectory()) throw new Error("Incoming snapshot: invalid-root");
  const state: Capture = {
    root: realpathSync(source),
    entries: [],
    observations: [],
    files: 0,
    bytes: 0,
    limits,
    discovered: 1,
    nameBytes: 0,
    manifestBytes: Buffer.byteLength(snapshotManifest([], limits.maxManifestBytes)),
  };
  walk(source, destination, "", state, 0);
  for (const observation of state.observations) {
    if (!unchanged(observation.info, lstatSync(observation.path, { bigint: true })))
      throw new Error("Incoming snapshot: source-changed");
  }
  return { entries: state.entries, files: state.files, bytes: state.bytes };
}
