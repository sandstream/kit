import { createHash } from "node:crypto";
import type { IncomingCheck } from "./decision.js";
import type { NpmArtifactResult } from "./npm-artifact.js";
import type { NpmArtifact, NpmLockInventory } from "./npm-lock.js";

export interface IncomingCandidateInput {
  /** Digest of a captured snapshot that the caller verified with `verifyIncomingSnapshot`. */
  snapshotDigest: string;
  inventory: NpmLockInventory;
  /** One `inspectNpmArtifact` result for each inventory artifact, in any order. */
  artifacts: readonly NpmArtifactResult[];
}

export type IncomingCandidate =
  | { status: "bound"; candidateDigest: string; checks: IncomingCheck[]; artifactCount: number }
  | { status: "refused"; reason: IncomingCandidateRefusal };

export type IncomingCandidateRefusal =
  | "invalid-snapshot-digest"
  | "inventory-incomplete"
  | "artifact-source-unsupported"
  | "artifact-not-verified"
  | "artifact-duplicate"
  | "artifact-unexpected"
  | "artifact-missing"
  | "artifact-selection-mismatch";

type Verified = Extract<NpmArtifactResult, { status: "verified" }>;

const SELECTION_FIELDS = [
  "packagePath",
  "name",
  "version",
  "source",
  "resolved",
  "integrity",
] as const;

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function refused(reason: IncomingCandidateRefusal): IncomingCandidate {
  return { status: "refused", reason };
}

function sameSelection(entry: NpmArtifact, selection: NpmArtifact): boolean {
  return SELECTION_FIELDS.every((field) => entry[field] === selection[field]);
}

function artifactTuple(result: Verified): unknown[] {
  const { selection, integrity, archive, manifest } = result;
  return [
    selection.packagePath,
    selection.name,
    selection.version,
    selection.source,
    selection.resolved,
    integrity.algorithm,
    integrity.matchedToken,
    integrity.actualDigest,
    integrity.byteCount,
    archive.root,
    archive.entryCount,
    archive.uncompressedBytes,
    manifest.name,
    manifest.version,
    Object.entries(manifest.scripts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  ];
}

/**
 * Bind one candidate identity from independently verified parts. A refusal never degrades to a
 * partial candidate: every inventory artifact needs exactly one verified result that matches it.
 * The digest names the captured inputs. It does not authorize execution and does not isolate it.
 */
export function bindIncomingCandidate(input: IncomingCandidateInput): IncomingCandidate {
  if (!/^[0-9a-f]{64}$/.test(input.snapshotDigest)) return refused("invalid-snapshot-digest");
  const { inventory } = input;
  if (inventory.completeness.status !== "complete") return refused("inventory-incomplete");
  for (const entry of inventory.artifacts) {
    if (entry.source !== "registry-tarball" && entry.source !== "remote-tarball") {
      return refused("artifact-source-unsupported");
    }
  }
  const byPath = new Map<string, Verified>();
  const known = new Set(inventory.artifacts.map((entry) => entry.packagePath));
  for (const result of input.artifacts) {
    if (result.status !== "verified") return refused("artifact-not-verified");
    const path = result.selection.packagePath;
    if (byPath.has(path)) return refused("artifact-duplicate");
    if (!known.has(path)) return refused("artifact-unexpected");
    byPath.set(path, result);
  }
  for (const entry of inventory.artifacts) {
    const result = byPath.get(entry.packagePath);
    if (!result) return refused("artifact-missing");
    if (!sameSelection(entry, result.selection)) return refused("artifact-selection-mismatch");
  }
  const tuples = [...byPath.values()]
    .map(artifactTuple)
    .sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0));
  const artifactsDigest = sha256(["kit.incoming-artifacts", 1, tuples]);
  const inventoryDigest = sha256([
    "kit.incoming-inventory",
    1,
    inventory.lockfileName,
    inventory.lockfileVersion,
    inventory.packages,
    inventory.artifacts,
    inventory.edges,
    inventory.scripts,
  ]);
  const candidateDigest = sha256([
    "kit.incoming-candidate",
    1,
    input.snapshotDigest,
    inventoryDigest,
    artifactsDigest,
  ]);
  return {
    status: "bound",
    candidateDigest,
    artifactCount: tuples.length,
    checks: [
      { id: "snapshot", status: "pass", evidenceDigest: input.snapshotDigest },
      { id: "npm-artifacts", status: "pass", evidenceDigest: artifactsDigest },
    ],
  };
}
