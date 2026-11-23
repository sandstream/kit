import { lstatSync, mkdirSync, opendirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sameIdentity } from "../utils/same-file.js";
import { secureDirStrict, secureFileStrict } from "../utils/secure-perms.js";
import { inspectNpmArtifact, type NpmArtifactResult } from "./npm-artifact.js";
import type { NpmArtifact } from "./npm-lock.js";
import { readSnapshotBytes, unchanged } from "./snapshot-io.js";
import { assertPrivateEntry } from "./snapshot-tree.js";

const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;

function archiveName(index: number): string {
  return `${index}.tgz`;
}

function privateDirectory(path: string) {
  const info = lstatSync(path, { bigint: true });
  if (!info.isDirectory()) throw new Error("Incoming candidate: invalid artifact directory");
  assertPrivateEntry(path, info);
  return info;
}

export function retainCandidateArchives(destination: string) {
  const path = join(destination, "artifacts");
  mkdirSync(path, { mode: 0o700 });
  secureDirStrict(path);
  const directory = privateDirectory(path);
  let total = 0;
  let index = 0;
  return (bytes: Buffer): void => {
    if (!sameIdentity(directory, privateDirectory(path))) {
      throw new Error("Incoming candidate: artifact directory changed");
    }
    total += bytes.length;
    if (total > MAX_TOTAL_BYTES) throw new Error("Incoming candidate: artifact byte limit");
    const filename = join(path, archiveName(index++));
    writeFileSync(filename, bytes, { flag: "wx", mode: 0o600 });
    secureFileStrict(filename);
  };
}

function validateLayout(path: string, count: number): void {
  const expected = new Set(Array.from({ length: count }, (_, index) => archiveName(index)));
  const directory = opendirSync(path);
  try {
    for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
      if (!entry.isFile() || !expected.delete(entry.name)) {
        throw new Error("Incoming candidate: unexpected archive");
      }
    }
    if (expected.size !== 0) throw new Error("Incoming candidate: missing archive");
  } finally {
    directory.closeSync();
  }
}

export function inspectCandidateArchives(
  destination: string,
  selections: readonly NpmArtifact[],
): NpmArtifactResult[] {
  const path = join(destination, "artifacts");
  const directory = privateDirectory(path);
  validateLayout(path, selections.length);
  let remaining = MAX_TOTAL_BYTES;
  const artifacts = selections.map((selection, index) => {
    const filename = join(path, archiveName(index));
    const info = lstatSync(filename, { bigint: true });
    assertPrivateEntry(filename, info);
    const bytes = readSnapshotBytes(filename, info, Math.min(remaining, MAX_ARCHIVE_BYTES));
    remaining -= bytes.length;
    return inspectNpmArtifact(bytes, selection);
  });
  if (!unchanged(directory, privateDirectory(path))) {
    throw new Error("Incoming candidate: artifact directory changed");
  }
  return artifacts;
}
