import type { IncomingTrustState, StoredIncomingDecision } from "./authority-store.js";
import {
  verifyRetainedIncomingCandidate,
  type IncomingCandidateFlowRefusal,
} from "./candidate-flow.js";
import { stateContext } from "./authority-state.js";
import { incomingVerificationDigest } from "./decision-protocol.js";
import { decideIncomingExecution, type IncomingVerification } from "./decision.js";

export type IncomingPreflight =
  | { verified: true }
  | {
      verified: false;
      reason:
        | Extract<StoredIncomingDecision, { allowed: false }>["reason"]
        | IncomingCandidateFlowRefusal
        | "missing-staged-evidence"
        | "read-only";
    };

export function decideStoredApproval(
  state: IncomingTrustState | null,
  candidateDigest: string,
  now: number,
): StoredIncomingDecision {
  if (!state) return { allowed: false, reason: "not-enrolled" };
  if (state.phase !== "accepted") return { allowed: false, reason: state.phase };
  if (candidateDigest !== state.candidateDigest)
    return { allowed: false, reason: "candidate-mismatch" };
  return decideIncomingExecution(
    stateContext(state),
    state.acceptance?.verification,
    state.acceptance?.approval,
    state.authority,
    now,
  );
}

/** Run inside the authority transaction. A result describes this check only. */
export function verifyLockedApproval(
  state: IncomingTrustState | null,
  expected: IncomingVerification,
  destination: string,
): IncomingPreflight {
  const { candidateDigest } = expected.context;
  const decision = decideStoredApproval(state, candidateDigest, Date.now());
  if (!decision.allowed) return { verified: false, reason: decision.reason };
  if (
    !state?.acceptance ||
    incomingVerificationDigest(expected) !== state.acceptance.approval.verificationDigest
  )
    return { verified: false, reason: "verification-mismatch" };
  const snapshot = state.evidence.find(
    (check) => check.id === "snapshot" && check.status === "pass",
  );
  const artifacts = state.evidence.find(
    (check) => check.id === "npm-artifacts" && check.status === "pass",
  );
  if (!snapshot || !artifacts) return { verified: false, reason: "missing-staged-evidence" };
  const verified = verifyRetainedIncomingCandidate(destination, {
    snapshotDigest: snapshot.evidenceDigest,
    candidateDigest,
    artifactsDigest: artifacts.evidenceDigest,
  });
  if (!verified.ok) return { verified: false, reason: verified.reason };
  const current = decideStoredApproval(state, candidateDigest, Date.now());
  return current.allowed ? { verified: true } : { verified: false, reason: current.reason };
}
