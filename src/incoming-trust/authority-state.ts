import type { IncomingTrustAction, IncomingTrustState } from "./authority-store.js";
import {
  incomingApproval,
  incomingAuthority,
  incomingTimestamp,
  incomingVerification,
} from "./decision-schema.js";
import { incomingAuthorityKeys } from "./decision-protocol.js";
import {
  decideIncomingExecution,
  type IncomingAuthority,
  type IncomingContext,
} from "./decision.js";

export function stateContext(state: IncomingTrustState): IncomingContext {
  if (!state.candidateDigest) throw new Error("Incoming trust: no-candidate");
  const { repositoryId, baselineDigest, policyDigest, generation } = state.authority;
  return {
    schema: 1,
    repositoryId,
    baselineDigest,
    policyDigest,
    generation,
    candidateDigest: state.candidateDigest,
  };
}

export function validDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export function validAuthority(value: unknown): value is IncomingAuthority {
  if (!incomingAuthority(value)) return false;
  const keys = incomingAuthorityKeys(value);
  if (!keys) return false;
  // Crypto parsers can ignore trailing PEM blocks. Never persist a private-key bundle.
  return value.signers.every(
    (signer) =>
      signer.publicKeyPem.replaceAll("\r\n", "\n").trim() ===
      keys.get(signer.id)!.export({ type: "spki", format: "pem" }).toString().trim(),
  );
}

export function validateAction(action: IncomingTrustAction): void {
  if (!action || typeof action !== "object" || Array.isArray(action))
    throw new Error("Incoming trust: invalid-action");
  const keys = {
    enroll: ["type", "authority"],
    stage: ["type", "expectedGeneration", "expectedPhase", "candidateDigest"],
    accept: ["type", "expectedGeneration", "expectedPhase", "verification", "approval", "now"],
    reject: ["type", "expectedGeneration", "expectedPhase"],
    retry: ["type", "expectedGeneration", "expectedPhase"],
    rotate: ["type", "expectedGeneration", "expectedPhase", "signers"],
  };
  if (typeof action.type !== "string" || !Object.hasOwn(keys, action.type))
    throw new Error("Incoming trust: invalid-action");
  const names = keys[action.type];
  if (Object.keys(action).length !== names.length || !names.every((k) => Object.hasOwn(action, k)))
    throw new Error("Incoming trust: invalid-action");
  if (action.type === "enroll") {
    if (!validAuthority(action.authority) || action.authority.generation !== 1)
      throw new Error("Incoming trust: invalid-authority");
  } else {
    if (!incomingTimestamp(action.expectedGeneration) || action.expectedGeneration === 0)
      throw new Error("Incoming trust: invalid-action");
    validateChange(action);
  }
}

function validateChange(action: Exclude<IncomingTrustAction, { type: "enroll" }>): void {
  if (!["pending", "accepted", "rejected"].includes(action.expectedPhase))
    throw new Error("Incoming trust: invalid-action");
  if (action.type === "stage" && !validDigest(action.candidateDigest))
    throw new Error("Incoming trust: invalid-action");
  if (
    action.type === "accept" &&
    (!incomingVerification(action.verification) ||
      !incomingApproval(action.approval) ||
      !incomingTimestamp(action.now))
  )
    throw new Error("Incoming trust: invalid-action");
}

function advance(state: IncomingTrustState, phase: "pending" | "rejected"): IncomingTrustState {
  const generation = state.authority.generation + 1;
  if (!Number.isSafeInteger(generation)) throw new Error("Incoming trust: generation-exhausted");
  const baselineDigest =
    state.phase === "accepted" ? state.candidateDigest! : state.authority.baselineDigest;
  return {
    ...state,
    phase,
    acceptance: null,
    authority: { ...state.authority, generation, baselineDigest },
  };
}

/** New signers void every earlier approval: the state returns to pending at a new generation. */
function rotate(
  state: IncomingTrustState,
  signers: IncomingAuthority["signers"],
): IncomingTrustState {
  const unchanged = JSON.stringify(signers) === JSON.stringify(state.authority.signers);
  const next = { ...advance(state, "pending") };
  next.authority = { ...next.authority, signers };
  if (unchanged || !validAuthority(next.authority))
    throw new Error("Incoming trust: invalid-signers");
  return next;
}

export function transition(
  state: IncomingTrustState,
  action: Exclude<IncomingTrustAction, { type: "enroll" }>,
): IncomingTrustState {
  if (action.expectedGeneration !== state.authority.generation)
    throw new Error("Incoming trust: stale-generation");
  if (action.expectedPhase !== state.phase) throw new Error("Incoming trust: stale-state");
  if (action.type === "stage") {
    return action.candidateDigest === state.candidateDigest
      ? state
      : { ...advance(state, "pending"), candidateDigest: action.candidateDigest };
  }
  if (action.type === "accept") {
    if (state.phase !== "pending") throw new Error("Incoming trust: not-pending");
    const decision = decideIncomingExecution(
      stateContext(state),
      action.verification,
      action.approval,
      state.authority,
      action.now,
    );
    if (!decision.allowed) throw new Error(`Incoming trust: ${decision.reason}`);
    return {
      ...state,
      phase: "accepted",
      acceptance: { verification: action.verification, approval: action.approval },
    };
  }
  if (action.type === "rotate") return rotate(state, action.signers);
  if (action.type === "reject")
    return state.phase === "rejected" ? state : advance(state, "rejected");
  if (state.phase !== "rejected") throw new Error("Incoming trust: not-rejected");
  return advance(state, "pending");
}

export function decodeState(body: unknown): IncomingTrustState {
  if (typeof body !== "string" || Buffer.byteLength(body) > 1024 * 1024)
    throw new Error("Incoming trust: invalid-state");
  const state = JSON.parse(body) as IncomingTrustState;
  if (!validState(state)) throw new Error("Incoming trust: invalid-state");
  return state;
}

function validState(value: unknown): value is IncomingTrustState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as IncomingTrustState;
  const fields = ["schema", "authority", "phase", "candidateDigest", "acceptance"];
  if (Object.keys(state).length !== fields.length || !fields.every((k) => Object.hasOwn(state, k)))
    return false;
  if (state.schema !== 1 || !validAuthority(state.authority)) return false;
  if (state.candidateDigest !== null && !validDigest(state.candidateDigest)) return false;
  if (state.phase === "pending" || state.phase === "rejected") return state.acceptance === null;
  return state.phase === "accepted" && validAcceptedState(state);
}

function validAcceptedState(state: IncomingTrustState): boolean {
  if (!state.candidateDigest || !state.acceptance) return false;
  const accepted = state.acceptance;
  if (typeof accepted !== "object" || Object.keys(accepted).length !== 2 || !accepted.approval)
    return false;
  return decideIncomingExecution(
    stateContext(state),
    accepted.verification,
    accepted.approval,
    state.authority,
    accepted.approval.issuedAt,
  ).allowed;
}
