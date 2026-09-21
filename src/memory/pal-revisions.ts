import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { deviceId } from "./device.js";
import { preparePalWriteGuards, withPalWrite } from "./pal-write-guard.js";
import { assertSupportedMemorySchema } from "./db-schema.js";
import {
  isCompleteState,
  portableState,
  rowState,
  STATE_FIELDS,
  stateKey,
  stateValues,
  parseClaimOwner,
  type PalClaimOwner,
  type PortablePalState,
} from "./pal-state-codec.js";
export type { PortablePalState, PalClaimOwner } from "./pal-state-codec.js";

type Row = Record<string, unknown>;

export interface PalRevision {
  id: string;
  syncId: string;
  parents: string[];
  state: PortablePalState;
  actorDevice: string | null;
  observed: boolean;
  recordedAt: string | null;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function actionRow(db: DatabaseSync, id: string): Row | undefined {
  return db.prepare("SELECT * FROM pending_actions WHERE id=?").get(id);
}

function revisionFromRow(row: Row): PalRevision {
  let parents: unknown;
  let state: unknown;
  try {
    parents = JSON.parse(String(row.parents_json));
    state = JSON.parse(String(row.state_json));
  } catch {
    throw new Error("Invalid pending-action revision encoding");
  }
  if (
    typeof row.rev_id !== "string" ||
    !/^[a-f0-9]{32}(?:[a-f0-9]{32})?$/.test(row.rev_id) ||
    typeof row.sync_id !== "string" ||
    !Array.isArray(parents) ||
    parents.some((id) => typeof id !== "string") ||
    new Set(parents).size !== parents.length ||
    !isCompleteState(state) ||
    ![0, 1].includes(row.observed as number) ||
    (row.actor_device !== null && typeof row.actor_device !== "string") ||
    (row.recorded_at !== null && typeof row.recorded_at !== "string")
  ) {
    throw new Error("Invalid pending-action revision");
  }
  return {
    id: row.rev_id,
    syncId: row.sync_id,
    parents: [...parents].sort(),
    state: portableState(state as Row),
    actorDevice: row.actor_device as string | null,
    observed: row.observed === 1,
    recordedAt: row.recorded_at as string | null,
  };
}

function revisions(db: DatabaseSync, syncId: string): PalRevision[] {
  return db
    .prepare("SELECT * FROM pal_revisions WHERE sync_id=? ORDER BY rev_id")
    .all(syncId)
    .map(revisionFromRow);
}

/** Every parent must belong to this complete action graph; timestamps never order events. */
function headsOf(history: PalRevision[]): PalRevision[] {
  const byId = new Map(history.map((revision) => [revision.id, revision]));
  const children = new Map<string, string[]>();
  const remaining = new Map<string, number>();
  for (const revision of history) {
    remaining.set(revision.id, revision.parents.length);
    for (const parent of revision.parents) {
      if (!byId.has(parent))
        throw new Error("Pending-action revision has a missing or foreign parent");
      const siblings = children.get(parent);
      if (siblings) siblings.push(revision.id);
      else children.set(parent, [revision.id]);
    }
  }
  const ready = history.filter((revision) => !revision.parents.length).map(({ id }) => id);
  for (let i = 0; i < ready.length; i++) {
    for (const child of children.get(ready[i]) ?? []) {
      const count = remaining.get(child)! - 1;
      remaining.set(child, count);
      if (!count) ready.push(child);
    }
  }
  if (ready.length !== history.length)
    throw new Error("Pending-action revision ancestry contains a cycle");
  return history.filter((revision) => !children.has(revision.id));
}

function insertRevision(db: DatabaseSync, revision: PalRevision): boolean {
  const existing = db.prepare("SELECT * FROM pal_revisions WHERE rev_id=?").get(revision.id);
  if (existing) {
    if (JSON.stringify(revisionFromRow(existing)) !== JSON.stringify(revision))
      throw new Error("Pending-action revision identity has conflicting contents");
    return false;
  }
  db.prepare(
    `INSERT INTO pal_revisions
    (rev_id, sync_id, parents_json, state_json, actor_device, observed, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    revision.id,
    revision.syncId,
    JSON.stringify(revision.parents),
    JSON.stringify(revision.state),
    revision.actorDevice,
    Number(revision.observed),
    revision.recordedAt,
  );
  return true;
}

function observation(row: Row): PalRevision {
  const state = rowState(row, true);
  const identity = [
    row.sync_id,
    row.origin_id ?? row.id,
    row.origin_device ?? null,
    row.origin_root ?? null,
  ];
  return {
    id: digest(["legacy-observation", identity, state]),
    syncId: String(row.sync_id),
    parents: [],
    state,
    actorDevice: null,
    observed: true,
    recordedAt: null,
  };
}

export function recordLegacyAction(db: DatabaseSync, id: string): void {
  const row = actionRow(db, id);
  if (!row || revisions(db, String(row.sync_id)).length)
    throw new Error("A legacy observation requires a newly imported action without history");
  insertRevision(db, observation(row));
}

/** Historical stores may lack metadata; declared causal stores must retain both history tables. */
export function assertCausalTables(db: DatabaseSync): boolean {
  const alreadyCausal = (assertSupportedMemorySchema(db) ?? 0) >= 15;
  if (
    alreadyCausal &&
    ["pal_revisions", "pal_tombstones"].some(
      (name) => !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name),
    )
  ) {
    throw new Error("Pending-action causal history is missing; recover from an intact store");
  }
  return alreadyCausal;
}

/** Missing projections must not make retained history disappear during forwarding. */
export function assertNoOrphanActionHistory(db: DatabaseSync, target?: DatabaseSync): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pal_revisions'").get())
    return;
  const sourceDeletions =
    target &&
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pal_tombstones'").get()
      ? db.prepare("SELECT 1 FROM pal_tombstones WHERE sync_id=?")
      : undefined;
  const targetDeletions = target?.prepare("SELECT 1 FROM pal_tombstones WHERE sync_id=?");
  for (const row of db
    .prepare(
      `SELECT DISTINCT r.sync_id FROM pal_revisions r
    WHERE NOT EXISTS (SELECT 1 FROM pending_actions p WHERE p.sync_id=r.sync_id)`,
    )
    .iterate()) {
    if (sourceDeletions?.get(row.sync_id) || targetDeletions?.get(row.sync_id)) continue;
    throw new Error("Orphan pending-action history has no task; recover from an intact store");
  }
}

export function prepareRevisionHistory(db: DatabaseSync): void {
  const alreadyCausal = assertCausalTables(db);
  db.exec(`CREATE TABLE IF NOT EXISTS pal_revisions (
    rev_id TEXT PRIMARY KEY, sync_id TEXT NOT NULL, parents_json TEXT NOT NULL,
    state_json TEXT NOT NULL, actor_device TEXT, observed INTEGER NOT NULL,
    recorded_at TEXT
  ); CREATE INDEX IF NOT EXISTS idx_pal_revisions_sync ON pal_revisions(sync_id);
  CREATE TABLE IF NOT EXISTS pal_tombstones (sync_id TEXT PRIMARY KEY NOT NULL);
  CREATE TRIGGER IF NOT EXISTS pal_revision_version AFTER INSERT ON pal_revisions BEGIN
    UPDATE pending_action_versions SET token=lower(hex(randomblob(16)))
      WHERE action_id IN (SELECT id FROM pending_actions WHERE sync_id=new.sync_id);
  END`);
  for (const row of db
    .prepare(
      `SELECT * FROM pending_actions WHERE NOT EXISTS
    (SELECT 1 FROM pal_revisions WHERE sync_id = pending_actions.sync_id)`,
    )
    .all()) {
    if (alreadyCausal)
      throw new Error("Pending-action causal history is missing; recover from an intact store");
    insertRevision(db, observation(row));
  }
  assertNoOrphanActionHistory(db);
  preparePalWriteGuards(db, STATE_FIELDS);
  // Pre-fix writers treated equal-valued competing claims as uncontested. This
  // repairs only the derived display flag; it does not manufacture an event.
  for (const row of db
    .prepare("SELECT id, state_conflict FROM pending_actions WHERE status='claimed'")
    .all()) {
    const conflict = Number(readActionHistory(db, String(row.id))!.conflict);
    if (row.state_conflict !== conflict)
      db.prepare("UPDATE pending_actions SET state_conflict=?, verify_passes=0 WHERE id=?").run(
        conflict,
        row.id,
      );
  }
}

export interface PalView {
  id: string;
  syncId: string;
  origin: { id: string | null; device: string | null; root: string | null };
  frontier: string;
  heads: PalRevision[];
  conflict: boolean;
  history?: PalRevision[];
}

export interface PalWriteOptions {
  expectedFrontier?: string;
  owner?: PalClaimOwner;
}

export class PalStateError extends Error {
  constructor(
    public readonly code: "stale" | "conflict" | "not-owner" | "owner-required" | "legacy-owner",
    message: string,
  ) {
    super(message);
    this.name = "PalStateError";
  }
}

function validateFrontier(frontier: string): void {
  if (typeof frontier !== "string" || !/^[a-f0-9]{64}$/.test(frontier))
    throw new RangeError("Expected frontier must be a 64-character lowercase hex digest");
}

export function claimContextOwner(opts: PalWriteOptions): PalClaimOwner {
  if (!opts?.owner || opts.expectedFrontier === undefined)
    throw new PalStateError(
      "owner-required",
      "Claim operations require session ownership and an observed frontier",
    );
  validateFrontier(opts.expectedFrontier);
  const owner = parseClaimOwner(opts.owner);
  if (owner.device !== deviceId({ persist: false }))
    throw new PalStateError("not-owner", "Claim owner does not match this device");
  return owner;
}

export function assertClaimContext(state: PortablePalState, opts: PalWriteOptions): void {
  if (!state.claim_owner)
    throw new PalStateError(
      "legacy-owner",
      "Legacy claim has unknown session ownership; use explicit takeover",
    );
  const owner = claimContextOwner(opts);
  if (JSON.stringify(owner) !== JSON.stringify(state.claim_owner))
    throw new PalStateError(
      "not-owner",
      "This session does not own the claim; inspect it or take over explicitly",
    );
}

export type PalMutationResult = {
  status: "applied" | "unchanged" | "missing" | "stale";
  view?: PalView;
};

export function readActionHistory(
  db: DatabaseSync,
  id: string,
  opts: { history?: boolean } = {},
): PalView | null {
  const row = actionRow(db, id);
  if (!row) return null;
  const history = revisions(db, String(row.sync_id));
  if (!history.length)
    throw new Error("Pending-action causal history is missing; recover from an intact store");
  const heads = headsOf(history);
  return {
    id: String(row.id),
    syncId: String(row.sync_id),
    origin: {
      id: typeof row.origin_id === "string" ? row.origin_id : null,
      device: typeof row.origin_device === "string" ? row.origin_device : null,
      root: typeof row.origin_root === "string" ? row.origin_root : null,
    },
    ...(opts.history ? { history } : {}),
    heads,
    frontier: digest(heads.map(({ id }) => id).sort()),
    // Equal labels and wall-clock values do not establish exclusive claim ownership.
    conflict:
      new Set(heads.map(({ state }) => stateKey(state))).size > 1 ||
      (heads.length > 1 && heads.some(({ state }) => state.status === "claimed")),
  };
}

/** Savepoints compose with callers; acquire the SQLite writer before reading the frontier. */
export function revisionTransaction<T>(db: DatabaseSync, run: () => T): T {
  const name = "pal_revision_" + randomBytes(8).toString("hex");
  db.exec(`SAVEPOINT ${name}`);
  try {
    db.exec("UPDATE pal_revisions SET rev_id=rev_id WHERE 0");
    const result = run();
    db.exec(`RELEASE ${name}`);
    return result;
  } catch (error) {
    try {
      db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
    } catch {
      // SQLite may already have rolled back; preserve the original failure.
    }
    throw error;
  }
}

function writableAction(db: DatabaseSync, id: string, opts: PalWriteOptions) {
  const before = actionRow(db, id);
  const view = readActionHistory(db, id);
  if (view && opts.expectedFrontier !== undefined && view.frontier !== opts.expectedFrontier)
    throw new PalStateError("stale", "Pending-action frontier has changed; inspect it again");
  if (view?.conflict)
    throw new PalStateError(
      "conflict",
      "Pending action has unresolved state conflicts; inspect and resolve it first",
    );
  if (
    before &&
    (!view?.heads.length || stateKey(rowState(before)) !== stateKey(view.heads[0].state))
  )
    throw new Error("Pending action has unrecorded state; causal history cannot be inferred");
  if (view?.heads[0].state.status === "claimed") assertClaimContext(view.heads[0].state, opts);
  return { before, view };
}

export function writeActionRevision<T>(
  db: DatabaseSync,
  id: string,
  write: () => T,
  opts: PalWriteOptions = {},
  recordUnchanged = false,
): T {
  if (opts.expectedFrontier !== undefined) validateFrontier(opts.expectedFrontier);
  return withPalWrite(db, { mode: "state", id }, () =>
    revisionTransaction(db, () => {
      const { before, view } = writableAction(db, id, opts);
      const result = write();
      const after = actionRow(db, id);
      if (after && after.status === "claimed") {
        const owner = claimContextOwner(opts);
        if (JSON.stringify(rowState(after).claim_owner) !== JSON.stringify(owner))
          throw new PalStateError(
            "not-owner",
            "A claimed task must retain the caller's session owner",
          );
      }
      if (
        after &&
        (recordUnchanged || !before || stateKey(rowState(before)) !== stateKey(rowState(after)))
      ) {
        insertRevision(db, {
          id: randomBytes(16).toString("hex"),
          syncId: String(after.sync_id),
          parents: (view?.heads.map(({ id }) => id) ?? []).sort(),
          state: rowState(after),
          actorDevice: deviceId({ persist: false }),
          observed: false,
          recordedAt: new Date().toISOString(),
        });
      }
      return result;
    }),
  );
}

export function assertActionProjection(db: DatabaseSync, id: string): void {
  const row = actionRow(db, id);
  const view = readActionHistory(db, id);
  if (!row || !view?.heads.some(({ state }) => stateKey(state) === stateKey(rowState(row))))
    throw new Error("Pending action has unrecorded state; import cannot infer its history");
}

function projectState(
  db: DatabaseSync,
  id: string,
  state: PortablePalState,
  conflict: boolean,
): void {
  const assignments = STATE_FIELDS.map((field) => field + "=?").join(",");
  db.prepare(
    `UPDATE pending_actions SET ${assignments},
    verify_passes=0, state_conflict=? WHERE id=?`,
  ).run(...stateValues(state), Number(conflict), id);
}

export interface PalResolveOptions {
  expectedFrontier: string;
  owner?: PalClaimOwner;
  choice: { revision: string } | { state: PortablePalState };
}

function resolutionState(view: PalView, choice: PalResolveOptions["choice"]): PortablePalState {
  if (!choice || Object.keys(choice).length !== 1)
    throw new RangeError("Choose exactly one revision or complete portable state");
  if ("revision" in choice) {
    const chosen = view.heads.find(({ id }) => id === choice.revision);
    if (!chosen) throw new RangeError("Chosen revision must be a current head");
    return chosen.state;
  }
  if (!("state" in choice) || !isCompleteState(choice.state))
    throw new RangeError(
      "Supply exactly the portable state fields; local authority cannot be resolved",
    );
  return portableState(choice.state);
}

function authorizeResolution(
  view: PalView,
  state: PortablePalState,
  opts: PalResolveOptions,
  takeover: boolean,
): void {
  const claims = view.heads.filter((head) => head.state.status === "claimed");
  if (takeover) {
    const owner = claimContextOwner(opts);
    if (
      !claims.length ||
      state.status !== "claimed" ||
      JSON.stringify(state.claim_owner) !== JSON.stringify(owner)
    )
      throw new RangeError("Takeover requires an existing claim and the caller's session owner");
    return;
  }
  if (claims.length && view.conflict)
    throw new PalStateError(
      "conflict",
      "Contested claims require explicit takeover before resolution",
    );
  for (const head of claims) assertClaimContext(head.state, opts);
  if (
    state.status === "claimed" &&
    (!claims.length ||
      JSON.stringify(state.claim_owner) !== JSON.stringify(view.heads[0].state.claim_owner))
  )
    throw new PalStateError(
      "owner-required",
      "Create or transfer session ownership with claim or takeover",
    );
}

/** A resolution acknowledges every observed head, never an unseen offline branch. */
function writeResolution(
  db: DatabaseSync,
  id: string,
  opts: PalResolveOptions,
  takeover: boolean,
): PalMutationResult {
  validateFrontier(opts.expectedFrontier);
  return withPalWrite(db, { mode: "state", id }, () =>
    revisionTransaction(db, () => {
      const view = readActionHistory(db, id);
      if (!view) return { status: "missing" };
      if (view.frontier !== opts.expectedFrontier) return { status: "stale", view };
      const state = resolutionState(view, opts.choice);
      authorizeResolution(view, state, opts, takeover);
      if (!takeover && view.heads.length === 1 && stateKey(view.heads[0].state) === stateKey(state))
        return { status: "unchanged", view };
      insertRevision(db, {
        id: randomBytes(16).toString("hex"),
        syncId: view.syncId,
        parents: view.heads.map(({ id }) => id).sort(),
        state,
        actorDevice: deviceId({ persist: false }),
        observed: false,
        recordedAt: new Date().toISOString(),
      });
      projectState(db, id, state, false);
      return { status: "applied", view: readActionHistory(db, id)! };
    }),
  );
}

export function resolveActionHistory(
  db: DatabaseSync,
  id: string,
  opts: PalResolveOptions,
): PalMutationResult {
  return writeResolution(db, id, opts, false);
}

export function takeoverActionHistory(
  db: DatabaseSync,
  id: string,
  opts: PalResolveOptions,
): PalMutationResult {
  return writeResolution(db, id, opts, true);
}

export function mergeActionRevisionHistory(
  target: DatabaseSync,
  source: DatabaseSync,
  incoming: Row,
  localId: string,
): boolean {
  const syncId = String(incoming.sync_id);
  const hasHistory = !!source
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pal_revisions'")
    .get();
  const incomingHistory = hasHistory ? revisions(source, syncId) : [observation(incoming)];
  const incomingHeads = headsOf(incomingHistory);
  if (
    !incomingHeads.length ||
    !incomingHeads.some(({ state }) => stateKey(state) === stateKey(rowState(incoming)))
  ) {
    throw new Error("Pending-action projection does not match its revision history");
  }
  return withPalWrite(target, { mode: "import", syncId }, () => {
    let historyChanged = false;
    for (const revision of incomingHistory) {
      if (insertRevision(target, revision)) historyChanged = true;
    }
    const view = readActionHistory(target, localId)!;
    // A conflicted projection is only a deterministic display candidate; every head remains.
    const state = view.heads[0].state;
    const current = actionRow(target, localId)!;
    if (
      historyChanged ||
      stateKey(rowState(current)) !== stateKey(state) ||
      current.state_conflict !== Number(view.conflict)
    ) {
      projectState(target, localId, state, view.conflict);
    }
    return view.conflict;
  });
}
