import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { bindIncomingCandidate, type IncomingCandidate } from "./candidate.js";
import { fetchAndInspectNpmArtifact, type NpmArtifactResult } from "./npm-artifact.js";
import type { NpmArtifactFetchPolicy } from "./npm-artifact-fetch.js";
import { inspectNpmLock, type NpmLockfileName } from "./npm-lock.js";
import {
  captureIncomingSnapshot,
  verifyIncomingSnapshot,
  type IncomingSnapshot,
  type IncomingSnapshotLimits,
} from "./snapshot.js";

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
  let fd: number | undefined;
  try {
    // One descriptor for the check and the read, so the file cannot be swapped in between. A link is
    // refused by the open itself where the platform supports it.
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > MAX_INPUT_BYTES) return "unreadable";
    return readFileSync(fd);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
  } finally {
    if (fd !== undefined) closeSync(fd);
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

  const manifest = readInput(snapshot.tree, "package.json");
  if (typeof manifest === "string") return refuse("manifest-unreadable");
  const lock = selectLockfile(snapshot.tree);
  if (typeof lock === "string") return refuse(lock);

  const inventory = inspectNpmLock({
    manifest,
    lockfile: lock.bytes,
    lockfileName: lock.name,
  });
  if (inventory.artifacts.length > (request.maxArtifacts ?? DEFAULT_MAX_ARTIFACTS)) {
    return refuse("artifact-limit");
  }

  const artifacts: NpmArtifactResult[] = [];
  for (const selection of inventory.artifacts) {
    const result = await fetchAndInspectNpmArtifact(selection, request.fetchPolicy);
    if (result.status !== "verified") return refuse("artifact-refused", result);
    artifacts.push(result);
  }

  // The snapshot sits on a writable disk for the whole fetch. Bind only if it is still the capture.
  if (!verifyIncomingSnapshot(dirname(snapshot.tree), snapshot.digest, request.snapshotLimits).ok) {
    return refuse("snapshot-changed");
  }
  const candidate = bindIncomingCandidate({
    snapshotDigest: snapshot.digest,
    inventory,
    artifacts,
  });
  if (candidate.status === "refused") return refuse(candidate.reason);
  return { status: "bound", snapshot, candidate };
}
