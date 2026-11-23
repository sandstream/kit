import { lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { bindIncomingCandidate, type IncomingCandidate } from "./candidate.js";
import { inspectCandidateArchives, retainCandidateArchives } from "./candidate-artifacts.js";
import { fetchAndInspectNpmArtifact, type NpmArtifactResult } from "./npm-artifact.js";
import type { NpmArtifactFetchPolicy } from "./npm-artifact-fetch.js";
import { inspectNpmLock, type NpmLockfileName, type NpmLockInventory } from "./npm-lock.js";
import {
  captureIncomingSnapshot,
  verifyIncomingSnapshot,
  type IncomingSnapshot,
  type IncomingSnapshotLimits,
} from "./snapshot.js";
import { readSnapshotBytes } from "./snapshot-io.js";
import { assertPrivateEntry } from "./snapshot-tree.js";

const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_ARTIFACTS = 1000;
const LOCKFILES: readonly NpmLockfileName[] = ["package-lock.json", "npm-shrinkwrap.json"];

export interface IncomingCandidateRequest {
  /** Directory to capture. Nothing is read from it again after the capture. */
  source: string;
  /** New absolute directory that receives the protected snapshot. */
  destination: string;
  /** Independent host policy for artifact downloads. The lockfile cannot widen it. */
  fetchPolicy: NpmArtifactFetchPolicy;
  snapshotLimits?: Partial<IncomingSnapshotLimits>;
  maxArtifacts?: number;
}

export type IncomingCandidateFlowRefusal =
  | "snapshot-failed"
  | "manifest-unreadable"
  | "lockfile-missing"
  | "lockfile-ambiguous"
  | "lockfile-unreadable"
  | "artifact-limit"
  | "artifact-refused"
  | "artifact-storage"
  | "candidate-changed"
  | "snapshot-changed"
  | Extract<IncomingCandidate, { status: "refused" }>["reason"];

export type IncomingCandidateFlow =
  | {
      status: "bound";
      snapshot: IncomingSnapshot;
      candidate: Extract<IncomingCandidate, { status: "bound" }>;
    }
  | {
      status: "refused";
      reason: IncomingCandidateFlowRefusal;
      /** The artifact result that caused `artifact-refused`, so a reader can tell the causes apart. */
      artifact?: Exclude<NpmArtifactResult, { status: "verified" }>;
      /** Set once the snapshot exists. The caller owns that directory and decides whether to keep it. */
      snapshot?: IncomingSnapshot;
    };

function readInput(tree: string, name: string): Buffer | "missing" | "unreadable" {
  const path = join(tree, name);
  try {
    const info = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    if (!info) return "missing";
    assertPrivateEntry(path, info);
    return readSnapshotBytes(path, info, MAX_INPUT_BYTES);
  } catch {
    return "unreadable";
  }
}

function readInventory(
  tree: string,
  maxArtifacts: number,
): NpmLockInventory | IncomingCandidateFlowRefusal {
  const manifest = readInput(tree, "package.json");
  if (typeof manifest === "string") return "manifest-unreadable";
  const lock = selectLockfile(tree);
  if (typeof lock === "string") return lock;
  const inventory = inspectNpmLock({ manifest, lockfile: lock.bytes, lockfileName: lock.name });
  if (inventory.artifacts.length > maxArtifacts) return "artifact-limit";
  if (inventory.completeness.status !== "complete") return "inventory-incomplete";
  if (
    inventory.artifacts.some(
      (entry) => entry.source !== "registry-tarball" && entry.source !== "remote-tarball",
    )
  ) {
    return "artifact-source-unsupported";
  }
  return inventory;
}

/** Rebind the retained inputs with zero network access and compare to the expected candidate. */
export function verifyRetainedIncomingCandidate(
  destination: string,
  expected: { snapshotDigest: string; candidateDigest: string; artifactsDigest?: string },
  options?: Pick<IncomingCandidateRequest, "snapshotLimits" | "maxArtifacts">,
): { ok: true } | { ok: false; reason: IncomingCandidateFlowRefusal } {
  const verifySnapshot = () =>
    verifyIncomingSnapshot(
      destination,
      expected.snapshotDigest,
      options?.snapshotLimits,
      "candidate",
    ).ok;
  if (!verifySnapshot()) return { ok: false, reason: "snapshot-changed" };
  const inventory = readInventory(
    join(destination, "tree"),
    options?.maxArtifacts ?? DEFAULT_MAX_ARTIFACTS,
  );
  if (typeof inventory === "string") return { ok: false, reason: inventory };
  try {
    const candidate = bindIncomingCandidate({
      snapshotDigest: expected.snapshotDigest,
      inventory,
      artifacts: inspectCandidateArchives(destination, inventory.artifacts),
    });
    if (!verifySnapshot()) return { ok: false, reason: "snapshot-changed" };
    if (candidate.status !== "bound" || candidate.candidateDigest !== expected.candidateDigest)
      return { ok: false, reason: "candidate-changed" };
    const artifacts = candidate.checks.find((check) => check.id === "npm-artifacts");
    if (
      expected.artifactsDigest !== undefined &&
      expected.artifactsDigest !== artifacts?.evidenceDigest
    )
      return { ok: false, reason: "candidate-changed" };
    return { ok: true };
  } catch {
    return { ok: false, reason: "artifact-storage" };
  }
}

async function retainArtifacts(
  destination: string,
  inventory: NpmLockInventory,
  policy: NpmArtifactFetchPolicy,
): Promise<
  | { artifacts: NpmArtifactResult[] }
  | {
      reason: "artifact-storage" | "artifact-refused";
      artifact?: Exclude<NpmArtifactResult, { status: "verified" }>;
    }
> {
  try {
    const retain = retainCandidateArchives(destination);
    const artifacts: NpmArtifactResult[] = [];
    for (const selection of inventory.artifacts) {
      const result = await fetchAndInspectNpmArtifact(selection, policy, retain);
      if (result.status !== "verified") return { reason: "artifact-refused", artifact: result };
      artifacts.push(result);
    }
    return { artifacts };
  } catch {
    return { reason: "artifact-storage" };
  }
}

function selectLockfile(
  tree: string,
): { name: NpmLockfileName; bytes: Buffer } | IncomingCandidateFlowRefusal {
  const found: { name: NpmLockfileName; bytes: Buffer }[] = [];
  for (const name of LOCKFILES) {
    const bytes = readInput(tree, name);
    if (bytes === "unreadable") return "lockfile-unreadable";
    if (bytes !== "missing") found.push({ name, bytes });
  }
  if (found.length === 0) return "lockfile-missing";
  // npm itself prefers the shrinkwrap. Two candidate locks are an ambiguity the gate will not resolve.
  return found.length === 1 ? found[0]! : "lockfile-ambiguous";
}

/**
 * Capture the source once, read the manifest and lockfile from the protected copy, fetch and
 * inspect every locked artifact, re-verify the snapshot, and bind one candidate digest.
 * Any failure returns a refusal. The result does not authorize execution and does not isolate it.
 */
export async function captureIncomingCandidate(
  request: IncomingCandidateRequest,
): Promise<IncomingCandidateFlow> {
  let snapshot: IncomingSnapshot;
  try {
    snapshot = captureIncomingSnapshot(request.source, request.destination, request.snapshotLimits);
  } catch {
    return { status: "refused", reason: "snapshot-failed" };
  }
  const refuse = (
    reason: IncomingCandidateFlowRefusal,
    artifact?: Exclude<NpmArtifactResult, { status: "verified" }>,
  ): IncomingCandidateFlow => ({ status: "refused", reason, artifact, snapshot });

  const inventory = readInventory(snapshot.tree, request.maxArtifacts ?? DEFAULT_MAX_ARTIFACTS);
  if (typeof inventory === "string") return refuse(inventory);
  const destination = dirname(snapshot.tree);
  const retained = await retainArtifacts(destination, inventory, request.fetchPolicy);
  if ("reason" in retained) return refuse(retained.reason, retained.artifact);
  const candidate = bindIncomingCandidate({
    snapshotDigest: snapshot.digest,
    inventory,
    artifacts: retained.artifacts,
  });
  if (candidate.status === "refused") return refuse(candidate.reason);
  const verified = verifyRetainedIncomingCandidate(
    destination,
    {
      snapshotDigest: snapshot.digest,
      candidateDigest: candidate.candidateDigest,
    },
    request,
  );
  if (!verified.ok) return refuse(verified.reason);
  return { status: "bound", snapshot, candidate };
}
