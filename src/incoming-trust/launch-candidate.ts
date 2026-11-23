import { realpathSync } from "node:fs";
import { join } from "node:path";
import { isReadOnlyMode } from "../read-only-mode.js";
import type { IncomingTrustStore } from "./authority-store.js";
import { incomingVerificationDigest } from "./decision-protocol.js";
import { incomingVerification } from "./decision-schema.js";
import { prepareLaunchPolicy } from "./launch-policy.js";
import { launchNodeOnMac, type IncomingRun } from "./launch-node-macos.js";
import { withSealedCandidate } from "./sealed-candidate.js";

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
    const authority = join(realpathSync(store.directory), "authority.sqlite");
    const verificationDigest = incomingVerificationDigest(verification);
    const result = withSealedCandidate(source, (mounted, assertPinned) => {
      assertPinned();
      return store.withApprovedInputs(repository, mounted, verification, (deadline) => {
        const run = launchNodeOnMac({
          prepared,
          mounted,
          authority,
          repository,
          source,
          verificationDigest,
          deadline,
        });
        observation.result = run;
        return run;
      });
    });
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
