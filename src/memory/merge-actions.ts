import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { deviceId } from "./device.js";
import { assertActionProjection, mergeActionRevisionHistory } from "./pal-revisions.js";
import { mergeActionTombstones } from "./pal-forget.js";
import { withPalWrite } from "./pal-write-guard.js";

type Row = Record<string, unknown>;
type ProjectMapper = (origin: string | undefined) => string | undefined;
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const STATE_FIELDS = [
  "status",
  "title",
  "detail",
  "scope",
  "created_at",
  "next_check",
  "snooze_until",
  "closed_at",
  "claimed_by",
  "claimed_at",
];

export interface MergedActions {
  pending: number;
  pendingScopeRepairs: number;
  pendingIdRemaps: number;
  pendingStateDifferences: number;
  pendingDifferenceIds: string[];
  pendingLegacySnapshots: number;
}

/** Display ids are short/local; portable identity survives renaming and forwarding. */
export function prepareActionIdentity(db: DatabaseSync): void {
  const columns = new Set(
    db
      .prepare("PRAGMA table_info(pending_actions)")
      .all()
      .map((r) => r.name),
  );
  for (const name of ["sync_id", "origin_id", "recall_scope", "recall_device", "import_state"]) {
    if (!columns.has(name)) db.exec(`ALTER TABLE pending_actions ADD COLUMN ${name} TEXT`);
  }
  const assign = db.prepare("UPDATE pending_actions SET sync_id = ? WHERE id = ?");
  for (const row of db.prepare("SELECT * FROM pending_actions WHERE sync_id IS NULL").all()) {
    // Match an unchanged legacy snapshot already imported elsewhere. Once stored,
    // this identity stays stable even when the originating action later changes.
    assign.run(pendingActionSyncId(row), row.id as string);
  }
  db.exec(`
    UPDATE pending_actions SET origin_id = id WHERE origin_id IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_sync_id ON pending_actions(sync_id);
    CREATE TRIGGER IF NOT EXISTS pending_identity AFTER INSERT ON pending_actions
    WHEN new.sync_id IS NULL OR new.origin_id IS NULL BEGIN
      UPDATE pending_actions SET sync_id = COALESCE(new.sync_id, lower(hex(randomblob(16)))),
        origin_id = COALESCE(new.origin_id, new.id) WHERE id = new.id;
    END;
  `);
}

function stateHash(row: Row): string {
  return digest(STATE_FIELDS.map((key) => str(row[key])));
}

export function pendingActionSyncId(row: Row): string {
  const supplied = str(row.sync_id);
  if (supplied !== null) {
    if (!/^(?:[a-f0-9]{32}|legacy-[a-f0-9]{64})$/.test(supplied))
      throw new Error("invalid pending action sync identity");
    return supplied;
  }
  // Old snapshots have no stable identity. Deduplicate identical snapshots only;
  // never merge mutable state from unrelated stores by their four-character ids.
  return (
    "legacy-" + digest([str(row.id), str(row.origin_device), str(row.origin_root), stateHash(row)])
  );
}

function localId(db: DatabaseSync, incoming: string, syncId: string): string {
  if (!db.prepare("SELECT 1 FROM pending_actions WHERE id = ?").get(incoming)) return incoming;
  const id = "import-" + syncId;
  if (db.prepare("SELECT 1 FROM pending_actions WHERE id = ?").get(id))
    throw new Error("pending action display id collision; no action was overwritten");
  return id;
}

function insertAction(db: DatabaseSync, row: Row, syncId: string, id: string): void {
  withPalWrite(db, { mode: "import", syncId }, () =>
    db
      .prepare(
        `INSERT INTO pending_actions
    (id, sync_id, origin_id, origin_device, origin_root, status, title, detail, scope,
     kind, created_at, next_check, snooze_until, closed_at, claimed_by, claimed_at, import_state)
    VALUES ($id, $sync, $originId, $device, $root, $status, $title, $detail, $scope,
     'manual', $created, $next, $snooze, $closed, $claimedBy, $claimedAt, $state)`,
      )
      .run({
        id,
        sync: syncId,
        originId: str(row.origin_id) ?? str(row.id),
        device: str(row.origin_device),
        root: str(row.origin_root),
        status: str(row.status) ?? "open",
        title: str(row.title),
        detail: str(row.detail),
        scope: str(row.scope),
        created: str(row.created_at),
        next: str(row.next_check),
        snooze: str(row.snooze_until),
        closed: str(row.closed_at),
        claimedBy: str(row.claimed_by),
        claimedAt: str(row.claimed_at),
        state: stateHash(row),
      }),
  );
}

function repairActionScope(
  db: DatabaseSync,
  retained: Row,
  incoming: Row,
  map: ProjectMapper,
): number {
  // Only imported rows with unchanged raw scopes may be rehomed. Native actions
  // and locally edited scopes are not silently moved by a later snapshot.
  if (!retained.import_state || retained.scope !== str(incoming.scope)) return 0;
  const scope = map(str(retained.scope) ?? undefined);
  if (!scope) return 0;
  const device = deviceId();
  return Number(
    db
      .prepare(
        `UPDATE pending_actions SET recall_scope = ?, recall_device = ?
    WHERE id = ? AND (recall_scope IS NOT ? OR recall_device IS NOT ?)`,
      )
      .run(scope, device, retained.id as string, scope, device).changes,
  );
}

function sameOrigin(retained: Row, incoming: Row): boolean {
  return (
    retained.origin_id === (str(incoming.origin_id) ?? incoming.id) &&
    retained.origin_device === str(incoming.origin_device) &&
    retained.origin_root === str(incoming.origin_root)
  );
}

export function mergePendingActions(
  db: DatabaseSync,
  source: DatabaseSync,
  map: ProjectMapper,
): MergedActions {
  const result: MergedActions = {
    pending: 0,
    pendingScopeRepairs: 0,
    pendingIdRemaps: 0,
    pendingStateDifferences: 0,
    pendingDifferenceIds: [],
    pendingLegacySnapshots: 0,
  };
  mergeActionTombstones(db, source);
  for (const incoming of source.prepare("SELECT * FROM pending_actions").all()) {
    const syncId = pendingActionSyncId(incoming);
    if (db.prepare("SELECT 1 FROM pal_tombstones WHERE sync_id=?").get(syncId)) continue;
    const incomingId = str(incoming.id);
    if (!incomingId || typeof incoming.title !== "string")
      throw new Error("Invalid pending-action projection: id and title are required");
    if (str(incoming.sync_id) === null) result.pendingLegacySnapshots++;
    let retained = db.prepare("SELECT * FROM pending_actions WHERE sync_id = ?").get(syncId);
    if (!retained) {
      const id = localId(db, incomingId, syncId);
      insertAction(db, incoming, syncId, id);
      result.pending++;
      if (id !== incomingId) result.pendingIdRemaps++;
      retained = db.prepare("SELECT * FROM pending_actions WHERE id = ?").get(id)!;
    } else {
      if (!sameOrigin(retained, incoming))
        throw new Error("pending action sync identity has conflicting origin metadata");
      assertActionProjection(db, retained.id as string);
    }
    if (
      mergeActionRevisionHistory(
        db,
        source,
        { ...incoming, sync_id: syncId },
        retained.id as string,
      )
    ) {
      result.pendingStateDifferences++;
      result.pendingDifferenceIds.push(retained.id as string);
    }
    result.pendingScopeRepairs += repairActionScope(db, retained, incoming, map);
  }
  return result;
}
