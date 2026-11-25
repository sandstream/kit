import { isReadOnlyMode } from "../read-only-mode.js";
import type { IncomingTrustStore } from "./authority-store.js";
import { incomingVerificationDigest } from "./decision-protocol.js";
import { incomingVerification } from "./decision-schema.js";
import { prepareLaunchPolicy, type PreparedLaunchPolicy } from "./launch-policy.js";
import { launchNodeOnMac, type IncomingRun } from "./launch-node-macos.js";
import { withSealedCandidate, withSealedRuntime, withSealedRunTree } from "./sealed-candidate.js";
import type { ImageCleanupStep } from "./sealed-image-owner.js";
import { readApprovedRunTree } from "./runtime-tree.js";
import {
  finishRequiredDockerfileInspection,
  requiredDockerfilePaths,
} from "./required-dockerfile-report.js";

interface LaunchRequest {
  store: IncomingTrustStore;
  repository: string;
  source: string;
  verification: unknown;
  policy: unknown;
}

interface RunObservation {
  result?: IncomingRun;
  requiredFiles?: ReadonlySet<string>;
}

function withApprovedRunTree(
  mounted: string,
  prepared: PreparedLaunchPolicy,
  observation: RunObservation,
  use: Parameters<typeof withSealedRunTree<IncomingRun>>[1],
  host: Parameters<typeof withSealedRunTree<IncomingRun>>[2],
) {
  const approved = readApprovedRunTree(mounted, prepared.policy.npmArtifacts);
  if (!approved.ok) return { ran: false, reason: approved.reason } as const;
  if (prepared.policy.requiredCheck) {
    observation.requiredFiles = requiredDockerfilePaths(
      approved.tree.entries,
      prepared.policy.entry,
    );
    if (!observation.requiredFiles)
      return { ran: false, reason: "required-check-input-unverified" } as const;
  }
  return withSealedRunTree(approved.tree, use, host);
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
  const observation: RunObservation = {};
  const finish = (run: IncomingRun) =>
    prepared.policy.requiredCheck
      ? finishRequiredDockerfileInspection(run, observation.requiredFiles)
      : run;
  try {
    const verificationDigest = incomingVerificationDigest(verification);
    const assertStableBuild = () => assertStableRuntime(prepared);
    const result = withSealedRuntime(
      prepared.runtime,
      prepared.runtimeDigest,
      (runtime, assertRuntime, ownerExecutable) => {
        const imageOwnerHost = { executable: ownerExecutable, assertStableBuild };
        return withSealedCandidate(
          source,
          (mounted, assertPinned) => {
            assertRuntime();
            assertPinned();
            return store.withApprovedInputs(
              repository,
              mounted,
              verification,
              (deadline, authority) =>
                withApprovedRunTree(
                  mounted,
                  prepared,
                  observation,
                  (input, inputDigest, assertRunTree) => {
                    const run = launchNodeOnMac({
                      prepared,
                      runtime,
                      mounted,
                      input,
                      inputDigest,
                      authority,
                      repository,
                      source,
                      verificationDigest,
                      deadline,
                      assertBoundaries: () => {
                        assertRuntime();
                        assertPinned();
                        assertRunTree?.();
                      },
                    });
                    observation.result = run;
                    return run;
                  },
                  imageOwnerHost,
                ),
            );
          },
          imageOwnerHost,
        );
      },
      assertStableBuild,
    );
    if ("ran" in result) return finish(result);
    return finish(
      boundaryFailure(
        observation.result,
        result.reason,
        "cleanupStep" in result ? result.cleanupStep : undefined,
      ),
    );
  } catch {
    return finish(boundaryFailure(observation.result, "run-state-unavailable"));
  }
}

function assertStableRuntime(prepared: PreparedLaunchPolicy): void {
  if (!prepared.checkRuntime()) throw new Error("Kit host runtime changed");
}

function boundaryFailure(
  observed: IncomingRun | undefined,
  reason: string,
  cleanupStep?: ImageCleanupStep,
): IncomingRun {
  const cleanup = cleanupStep ? { cleanupStep } : {};
  if (observed?.ran === null) return { ...observed, ...cleanup };
  return observed?.ran
    ? { ...observed, ...cleanup, outcome: "boundary-failed", boundaryReason: reason }
    : { ran: false, reason, ...cleanup };
}
