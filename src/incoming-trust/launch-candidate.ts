import { opendirSync } from "node:fs";
import { join } from "node:path";
import { isReadOnlyMode } from "../read-only-mode.js";
import type { IncomingTrustStore } from "./authority-store.js";
import { incomingVerificationDigest } from "./decision-protocol.js";
import { incomingVerification } from "./decision-schema.js";
import { prepareLaunchPolicy } from "./launch-policy.js";
import { launchNodeOnMac, type IncomingRun } from "./launch-node-macos.js";
import { withSealedCandidate, withSealedRuntime } from "./sealed-candidate.js";
import { readSnapshotManifest } from "./snapshot-io.js";
import { snapshotLimits } from "./snapshot-limits.js";

interface LaunchRequest {
  store: IncomingTrustStore;
  repository: string;
  source: string;
  verification: unknown;
  policy: unknown;
}

/** The lock already verified this manifest and archive layout from the pinned image. */
function hasUnprovenDependencies(mounted: string): boolean {
  const archives = opendirSync(join(mounted, "artifacts"));
  try {
    if (archives.readSync()) return true;
  } finally {
    archives.closeSync();
  }
  const raw = readSnapshotManifest(
    join(mounted, "manifest.json"),
    snapshotLimits().maxManifestBytes,
  );
  const manifest = JSON.parse(raw) as { entries: { path: string }[] };
  return manifest.entries.some(
    ({ path }) =>
      path.toLowerCase().split("/").includes("node_modules") ||
      path.toLowerCase().endsWith(".node"),
  );
}

export function launchIncomingCandidate(request: LaunchRequest): IncomingRun {
  if (isReadOnlyMode()) return { ran: false, reason: "read-only" };
  const { store, repository, source, verification } = request;
  if (!incomingVerification(verification)) return { ran: false, reason: "invalid-verification" };
  const prepared = prepareLaunchPolicy(request.policy);
  if (!prepared.ok) return { ran: false, reason: prepared.reason };
  if (prepared.policyDigest !== verification.context.policyDigest)
    return { ran: false, reason: "run-policy-mismatch" };
  const original = store.preflight(repository, source, verification);
  if (!original.verified) return { ran: false, reason: original.reason };
  const observation: { result?: IncomingRun } = {};
  try {
    const verificationDigest = incomingVerificationDigest(verification);
    const result = withSealedRuntime(
      prepared.runtime,
      prepared.runtimeDigest,
      (runtime, assertRuntime) =>
        withSealedCandidate(source, (mounted, assertPinned) => {
          assertRuntime();
          assertPinned();
          return store.withApprovedInputs(
            repository,
            mounted,
            verification,
            (deadline, authority) => {
              if (hasUnprovenDependencies(mounted))
                return { ran: false, reason: "run-dependencies-unproven" } as const;
              const run = launchNodeOnMac({
                prepared,
                runtime,
                mounted,
                authority,
                repository,
                source,
                verificationDigest,
                deadline,
              });
              observation.result = run;
              return run;
            },
          );
        }),
    );
    return "ran" in result ? result : boundaryFailure(observation.result, result.reason);
  } catch {
    return boundaryFailure(observation.result, "run-state-unavailable");
  }
}

function boundaryFailure(observed: IncomingRun | undefined, reason: string): IncomingRun {
  return observed?.ran
    ? { ...observed, outcome: "boundary-failed", boundaryReason: reason }
    : { ran: false, reason };
}
