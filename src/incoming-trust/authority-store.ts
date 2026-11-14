import { join } from "node:path";
import { userInfo } from "node:os";
import {
  decideIncomingExecution,
  type IncomingApproval,
  type IncomingAuthority,
  type IncomingVerification,
  type IncomingDenial,
} from "./decision.js";
import type { DatabaseSync } from "node:sqlite";
import {
  QUARANTINE_ACKNOWLEDGEMENT,
  quarantineDatabase,
  withIncomingDatabase,
  type RepositoryBinding,
} from "./authority-files.js";
import {
  decodeState,
  stateContext,
  transition,
  validAuthority,
  validDigest,
  validateAction,
} from "./authority-state.js";
import { isReadOnlyMode } from "../read-only-mode.js";

export interface IncomingTrustState {
  schema: 1;
  authority: IncomingAuthority;
  phase: "pending" | "accepted" | "rejected";
  candidateDigest: string | null;
  acceptance: { verification: IncomingVerification; approval: IncomingApproval } | null;
}

export type IncomingTrustAction =
  | { type: "enroll"; authority: IncomingAuthority }
  | (IncomingStateExpectation & { type: "stage"; candidateDigest: string })
  | (IncomingStateExpectation & {
      type: "accept";
      verification: IncomingVerification;
      approval: IncomingApproval;
      now: number;
    })
  | (IncomingStateExpectation & { type: "reject" | "retry" })
  | (IncomingStateExpectation & { type: "rotate"; signers: IncomingAuthority["signers"] });

interface IncomingStateExpectation {
  expectedGeneration: number;
  expectedPhase: IncomingTrustState["phase"];
}

export type StoredIncomingDecision =
  | { allowed: true; reason: "accepted" }
  | {
      allowed: false;
      reason:
        | IncomingDenial
        | "not-enrolled"
        | "pending"
        | "rejected"
        | "candidate-mismatch"
        | "state-unavailable";
    };

function readState(db: DatabaseSync, binding: RepositoryBinding): IncomingTrustState | null {
  const row = db
    .prepare(
      `SELECT repository_id, device, inode, birthtime,
    CASE WHEN length(CAST(body AS BLOB)) <= 1048576 THEN body ELSE NULL END AS body
    FROM incoming WHERE root = ?`,
    )
    .get(binding.root);
  if (!row) return null;
  if (
    row.device !== binding.device ||
    row.inode !== binding.inode ||
    row.birthtime !== binding.birthtime
  ) {
    throw new Error("Incoming trust: repository-binding-changed");
  }
  const state = decodeState(row.body);
  if (state.authority.repositoryId !== row.repository_id)
    throw new Error("Incoming trust: invalid-state");
  return state;
}

function enroll(
  db: DatabaseSync,
  binding: RepositoryBinding,
  authority: IncomingAuthority,
): IncomingTrustState {
  if (!validAuthority(authority) || authority.generation !== 1)
    throw new Error("Incoming trust: invalid-authority");
  if (readState(db, binding)) throw new Error("Incoming trust: already-enrolled");
  const state: IncomingTrustState = {
    schema: 1,
    authority,
    phase: "pending",
    candidateDigest: null,
    acceptance: null,
  };
  db.prepare(
    "INSERT INTO incoming (root, repository_id, device, inode, birthtime, body) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    binding.root,
    authority.repositoryId,
    binding.device,
    binding.inode,
    binding.birthtime,
    JSON.stringify(state),
  );
  return decodeState(JSON.stringify(state));
}

/** Directory overrides belong to trusted host code, never incoming repository configuration. */
export class IncomingTrustStore {
  constructor(readonly directory = join(userInfo().homedir, ".kit", "incoming-trust")) {}

  /** This decision does not hold a launch lock or inspect the caller's actual filesystem inputs. */
  decide(repository: string, candidateDigest: string, now: number): StoredIncomingDecision {
    if (!validDigest(candidateDigest)) return { allowed: false, reason: "invalid-context" };
    try {
      const state = this.read(repository);
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
    } catch {
      return { allowed: false, reason: "state-unavailable" };
    }
  }

  read(repository: string): IncomingTrustState | null {
    return withIncomingDatabase(this.directory, repository, "read", readState);
  }

  /**
   * Explicit recovery of a damaged store. Moves the database aside as evidence and leaves an
   * empty store, so the repository must be enrolled again and no earlier approval survives.
   * Refused for a store that still reads correctly.
   */
  quarantineDamaged(
    repository: string,
    acknowledgement: typeof QUARANTINE_ACKNOWLEDGEMENT,
  ): { quarantinedTo: string } {
    if (isReadOnlyMode()) throw new Error("Incoming trust: read-only");
    if (acknowledgement !== QUARANTINE_ACKNOWLEDGEMENT)
      throw new Error("Incoming trust: acknowledgement-required");
    const readable = (): boolean => {
      try {
        this.read(repository);
        return true;
      } catch {
        return false;
      }
    };
    return { quarantinedTo: quarantineDatabase(this.directory, repository, readable) };
  }

  update(repository: string, action: IncomingTrustAction): IncomingTrustState {
    if (isReadOnlyMode()) throw new Error("Incoming trust: read-only");
    validateAction(action);
    const result = withIncomingDatabase(
      this.directory,
      repository,
      action.type === "enroll" ? "enroll" : "update",
      (db, binding) => {
        if (action.type === "enroll") return enroll(db, binding, action.authority);
        const previous = readState(db, binding);
        if (!previous) throw new Error("Incoming trust: not-enrolled");
        const state = decodeState(JSON.stringify(transition(previous, action)));
        db.prepare("UPDATE incoming SET body = ? WHERE root = ?").run(
          JSON.stringify(state),
          binding.root,
        );
        return state;
      },
    );
    if (!result) throw new Error("Incoming trust: not-enrolled");
    return result;
  }
}
