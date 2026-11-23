import { isReadOnlyMode } from "../read-only-mode.js";
import type { IncomingTrustStore } from "./authority-store.js";
import { incomingVerificationDigest } from "./decision-protocol.js";
import { incomingVerification } from "./decision-schema.js";
import { prepareLaunchPolicy } from "./launch-policy.js";
import { launchNodeOnMac, type IncomingRun } from "./launch-node-macos.js";
import { withSealedCandidate, withSealedRuntime, withSealedRunTree } from "./sealed-candidate.js";
import { readApprovedRunTree } from "./runtime-tree.js";

interface LaunchRequest {
  store: IncomingTrustStore;
  repository: string;
  source: string;
  verification: unknown;
  policy: unknown;
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
              const approved = readApprovedRunTree(mounted);
              if (!approved) return { ran: false, reason: "run-dependencies-unproven" } as const;
              return withSealedRunTree(approved, (input, inputDigest) => {
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
                });
                observation.result = run;
                return run;
              });
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
  if (observed?.ran === null) return observed;
  return observed?.ran
    ? { ...observed, outcome: "boundary-failed", boundaryReason: reason }
    : { ran: false, reason };
}
