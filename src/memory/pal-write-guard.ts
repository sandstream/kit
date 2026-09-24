import type { DatabaseSync } from "node:sqlite";

type WriteScope = {
  mode: "state" | "import" | "forget" | "migration";
  id?: string;
  syncId?: string;
};
const connections = new WeakMap<DatabaseSync, { scope?: WriteScope }>();

function register(db: DatabaseSync) {
  let connection = connections.get(db);
  if (connection) return connection;
  connection = {};
  const current = connection;
  const authorize = (operation: unknown, id: unknown, syncId: unknown) => {
    const scope = current.scope;
    if (!scope) return 0;
    if (scope.mode === "migration") return Number(operation === "state" || operation === "append");
    const matches =
      (scope.id !== undefined && scope.id === id) ||
      (scope.syncId !== undefined && scope.syncId === syncId);
    if (!matches) return 0;
    if (operation === "erase") return Number(scope.mode === "forget");
    return Number((operation === "state" || operation === "append") && scope.mode !== "forget");
  };
  // Migration can encounter old guards before upgrading them. Older clients do
  // not register v16, so they cannot write through the new persistent guards.
  db.function("kit_pal_write", authorize);
  db.function("kit_pal_write_v16", authorize);
  connections.set(db, connection);
  return connection;
}

/** Internal synchronous scope; SQL callers cannot acquire it by invoking the function. */
export function withPalWrite<T>(db: DatabaseSync, scope: WriteScope, run: () => T): T {
  const connection = register(db);
  const previous = connection.scope;
  connection.scope = scope;
  try {
    return run();
  } finally {
    connection.scope = previous;
  }
}

/** Persistent triggers also reject clients that do not register the connection-local function. */
export function preparePalWriteGuards(db: DatabaseSync, fields: readonly string[]): void {
  const guarded = [
    ...fields,
    "id",
    "sync_id",
    "origin_id",
    "origin_device",
    "origin_root",
    "state_conflict",
  ].join(",");
  for (const name of [
    "pal_state_insert",
    "pal_state_update",
    "pal_state_delete",
    "pal_history_insert",
    "pal_history_update",
    "pal_history_delete",
    "pal_tombstone_insert",
    "pal_tombstone_update",
    "pal_tombstone_delete",
  ])
    db.exec(`DROP TRIGGER IF EXISTS ${name}`);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS pal_state_insert BEFORE INSERT ON pending_actions
    WHEN NOT kit_pal_write_v16('state',new.id,new.sync_id) BEGIN
      SELECT RAISE(ABORT, 'Pending action changes require Kit causal writer');
    END;
    CREATE TRIGGER IF NOT EXISTS pal_state_update BEFORE UPDATE OF ${guarded} ON pending_actions
    WHEN NOT kit_pal_write_v16('state',old.id,old.sync_id) BEGIN
      SELECT RAISE(ABORT, 'Pending action changes require Kit causal writer');
    END;
    CREATE TRIGGER IF NOT EXISTS pal_state_delete BEFORE DELETE ON pending_actions
    WHEN NOT kit_pal_write_v16('erase',old.id,old.sync_id) BEGIN
      SELECT RAISE(ABORT, 'Pending action deletion requires Kit causal writer');
    END;
    CREATE TRIGGER IF NOT EXISTS pal_history_insert BEFORE INSERT ON pal_revisions
    WHEN NOT kit_pal_write_v16('append',
      (SELECT id FROM pending_actions WHERE sync_id=new.sync_id),new.sync_id)
    OR EXISTS (SELECT 1 FROM pal_revisions WHERE rev_id=new.rev_id)
    OR EXISTS (SELECT 1 FROM pal_tombstones WHERE sync_id=new.sync_id) BEGIN
      SELECT RAISE(ABORT, 'Revision append requires Kit causal writer and a fresh revision identity');
    END;
    CREATE TRIGGER IF NOT EXISTS pal_history_update BEFORE UPDATE ON pal_revisions BEGIN
      SELECT RAISE(ABORT, 'Pending action revisions are append-only');
    END;
    CREATE TRIGGER IF NOT EXISTS pal_history_delete BEFORE DELETE ON pal_revisions
    WHEN NOT kit_pal_write_v16('erase',NULL,old.sync_id)
      OR NOT EXISTS (SELECT 1 FROM pal_tombstones WHERE sync_id=old.sync_id) BEGIN
      SELECT RAISE(ABORT, 'Revision deletion requires Kit causal writer and a tombstone');
    END;
    CREATE TRIGGER IF NOT EXISTS pal_tombstone_insert BEFORE INSERT ON pal_tombstones
    WHEN NOT kit_pal_write_v16('erase',NULL,new.sync_id) BEGIN
      SELECT RAISE(ABORT, 'Task tombstones require Kit causal writer');
    END;
    CREATE TRIGGER IF NOT EXISTS pal_tombstone_update BEFORE UPDATE ON pal_tombstones BEGIN
      SELECT RAISE(ABORT, 'Task tombstones are append-only');
    END;
    CREATE TRIGGER IF NOT EXISTS pal_tombstone_delete BEFORE DELETE ON pal_tombstones BEGIN
      SELECT RAISE(ABORT, 'Task tombstones are append-only');
    END;
  `);
}
