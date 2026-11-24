import type { NpmArtifact } from "./npm-lock.js";
import {
  fetchNpmTarball,
  parseNpmArtifactUrl,
  type NpmArtifactFetchPolicy,
} from "./npm-artifact-fetch.js";
import { verifyNpmIntegrity, type NpmIntegrityResult } from "./npm-artifact-integrity.js";
import { inspectNpmTarball, type NpmArchiveEntry } from "./npm-artifact-archive.js";
import { inspectNpmManifest } from "./npm-artifact-manifest.js";
import { packageName } from "./npm-lock-read.js";
import { relativePath } from "./npm-lock-workspaces.js";

type SelectedArtifact = NpmArtifact & {
  name: string;
  version: string;
  resolved: string;
  integrity: string;
};

type Refusal = { status: "rejected" | "unsupported"; reason: string };

export type NpmArtifactResult =
  | {
      status: "verified";
      selection: NpmArtifact;
      integrity: Extract<NpmIntegrityResult, { status: "verified" }>;
      archive: { root: string; entryCount: number; uncompressedBytes: number };
      manifest: { name: string; version: string; scripts: Record<string, string> };
      scope: "exact-npm-artifact";
    }
  | Refusal;

/** Inspect selected artifact data. This interface grants no execution permission. */
export function inspectNpmArtifact(
  bytes: Buffer,
  selection: unknown,
  retain?: (root: string, entries: readonly NpmArchiveEntry[]) => void,
): NpmArtifactResult {
  const copied = copySelection(selection);
  if ("status" in copied) return copied;
  const selected = copied.value;
  if (!Buffer.isBuffer(bytes)) return { status: "rejected", reason: "invalid-artifact-bytes" };
  if (bytes.length > 16 * 1024 * 1024) return { status: "unsupported", reason: "compressed-limit" };
  const owned = Buffer.allocUnsafeSlow(bytes.length);
  owned.set(bytes);
  const integrity = verifyNpmIntegrity(owned, selected.integrity);
  if (integrity.status !== "verified") return integrity;
  let entries: readonly NpmArchiveEntry[] = [];
  const archive = inspectNpmTarball(
    owned,
    {},
    retain &&
      ((files) => {
        entries = files;
      }),
  );
  if (archive.status !== "verified") return archive;
  const manifest = inspectNpmManifest(archive.manifestBytes, selected);
  if (manifest.status !== "verified") return manifest;
  retain?.(archive.root, entries);
  return {
    status: "verified",
    selection: selected,
    integrity,
    archive: {
      root: archive.root,
      entryCount: archive.entryCount,
      uncompressedBytes: archive.uncompressedBytes,
    },
    manifest: { name: manifest.name, version: manifest.version, scripts: manifest.scripts },
    scope: "exact-npm-artifact",
  };
}

/** Fetch only the selected URL under independent host policy, then inspect the returned bytes. */
export async function fetchAndInspectNpmArtifact(
  selection: unknown,
  policy: NpmArtifactFetchPolicy,
  retain?: (verifiedBytes: Buffer) => void,
): Promise<NpmArtifactResult> {
  const copied = copySelection(selection);
  if ("status" in copied) return copied;
  const fetched = await fetchNpmTarball(copied.value.resolved, policy);
  if (fetched.status !== "retrieved") return fetched;
  const inspected = inspectNpmArtifact(fetched.bytes, copied.value);
  if (inspected.status === "verified") retain?.(fetched.bytes);
  return inspected;
}

function copySelection(selection: unknown): { value: SelectedArtifact } | Refusal {
  if (selection && typeof selection === "object" && !Array.isArray(selection)) {
    const source = Object.getOwnPropertyDescriptor(selection, "source")?.value;
    if (
      typeof source === "string" &&
      source !== "" &&
      source !== "registry-tarball" &&
      source !== "remote-tarball"
    ) {
      return { status: "unsupported", reason: "unsupported-artifact-source" };
    }
  }
  if (!selectedArtifact(selection))
    return { status: "rejected", reason: "invalid-artifact-selection" };
  const selected: SelectedArtifact = {
    packagePath: selection.packagePath,
    name: selection.name,
    version: selection.version,
    source: selection.source,
    resolved: selection.resolved,
    integrity: selection.integrity,
  };
  const source = parseNpmArtifactUrl(selected.resolved);
  if (source.status !== "valid") return source;
  if ((selected.source === "registry-tarball") !== (source.url.hostname === "registry.npmjs.org")) {
    return { status: "rejected", reason: "artifact-source-mismatch" };
  }
  return { value: selected };
}

function selectedArtifact(value: unknown): value is SelectedArtifact {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  for (const field of ["packagePath", "name", "version", "source", "resolved", "integrity"]) {
    const entry = Object.getOwnPropertyDescriptor(value, field);
    if (
      !entry ||
      !("value" in entry) ||
      typeof entry.value !== "string" ||
      entry.value.trim() === ""
    )
      return false;
  }
  const record = value as SelectedArtifact;
  return (
    relativePath(record.packagePath) &&
    Buffer.byteLength(record.packagePath) <= 4096 &&
    !/[*[\]{}!]/.test(record.packagePath) &&
    record.name.length <= 4096 &&
    packageName(record.name) &&
    exactNpmVersion(record.version)
  );
}

export function exactNpmVersion(version: string): boolean {
  if (version.length > 256) return false;
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      version,
    );
  return (
    match !== null &&
    (match[4] === undefined || match[4].split(".").every((part) => !/^0\d+$/.test(part)))
  );
}
