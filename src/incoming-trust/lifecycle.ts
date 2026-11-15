import type { IncomingTrustState, IncomingTrustStore } from "./authority-store.js";
import { carriesEvidence, stateContext } from "./authority-state.js";
import { incomingVerificationDigest } from "./decision-protocol.js";
import type { IncomingApproval, IncomingCheck, IncomingVerification } from "./decision.js";
import { incomingVerification } from "./decision-schema.js";

/**
 * Approval lifecycle over `IncomingTrustStore`. Every call reads the state once and passes the
 * observed generation and phase back, so the store refuses it if another writer moved first.
 * Nothing here holds a launch lock, and an accepted state does not authorize a running process.
 */

export interface IncomingApprovalRequest {
  verification: IncomingVerification;
  /** The digest that the external signer binds into the approval. */
  verificationDigest: string;
}

function current(store: IncomingTrustStore, repository: string): IncomingTrustState {
  const state = store.read(repository);
  if (!state) throw new Error("Incoming trust: not-enrolled");
  return state;
}

function expectation(state: IncomingTrustState) {
  return { expectedGeneration: state.authority.generation, expectedPhase: state.phase };
}

/** A candidate digest that equals the staged one changes nothing. A different one resets approval. */
export function stageCandidate(
  store: IncomingTrustStore,
  repository: string,
  candidateDigest: string,
  evidence: IncomingCheck[],
): IncomingTrustState {
  const state = current(store, repository);
  return store.update(repository, {
    type: "stage",
    ...expectation(state),
    candidateDigest,
    evidence,
  });
}

function requiredChecksPass(state: IncomingTrustState, checks: IncomingCheck[]): boolean {
  const passed = new Set(checks.filter((check) => check.status === "pass").map((c) => c.id));
  return (
    passed.size === checks.length &&
    state.authority.requiredChecks.every((name) => passed.has(name))
  );
}

/**
 * Build the verification report that the authority signs. Refuse early when the checks cannot
 * satisfy the enrolled authority, because such a report can never be accepted.
 */
export function requestApproval(
  store: IncomingTrustStore,
  repository: string,
  checks: IncomingCheck[],
  now: number,
): IncomingApprovalRequest {
  const state = current(store, repository);
  const context = stateContext(state);
  if (state.phase !== "pending") throw new Error("Incoming trust: not-pending");
  if (!carriesEvidence(state.evidence, checks))
    throw new Error("Incoming trust: evidence-mismatch");
  if (!requiredChecksPass(state, checks)) throw new Error("Incoming trust: checks-incomplete");
  const verification: IncomingVerification = {
    schema: 1,
    context,
    createdAt: now,
    checks: checks.map((check) => ({ ...check })),
  };
  if (!incomingVerification(verification)) throw new Error("Incoming trust: invalid-verification");
  return { verification, verificationDigest: incomingVerificationDigest(verification) };
}

/** The store verifies the signature, the context, the checks and the expiry inside its transaction. */
export function acceptCandidate(
  store: IncomingTrustStore,
  repository: string,
  verification: IncomingVerification,
  approval: IncomingApproval,
  now: number,
): IncomingTrustState {
  const state = current(store, repository);
  return store.update(repository, {
    type: "accept",
    ...expectation(state),
    verification,
    approval,
    now,
  });
}

export function rejectCandidate(store: IncomingTrustStore, repository: string): IncomingTrustState {
  const state = current(store, repository);
  return store.update(repository, { type: "reject", ...expectation(state) });
}

/** A retry returns a rejected state to pending. Fresh evidence and a fresh approval are required. */
export function retryCandidate(store: IncomingTrustStore, repository: string): IncomingTrustState {
  const state = current(store, repository);
  return store.update(repository, { type: "retry", ...expectation(state) });
}
