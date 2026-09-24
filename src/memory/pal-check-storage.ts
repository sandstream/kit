import { DatabaseSync } from "node:sqlite";
import type { PendingAction } from "./pal.js";
import { storedClaimOwner } from "./pal-state-codec.js";

/** Keep the field understood by older verifiers inert without discarding its definition. */
export function prepareActionChecks(db: DatabaseSync): void {
  const conflict = db
    .prepare(
      `SELECT 1 FROM pending_actions WHERE verify_check IS NOT NULL
    AND verify_definition IS NOT NULL AND verify_definition IS NOT verify_check`,
    )
    .get();
  if (conflict)
    throw new Error("Conflicting legacy and current verification definitions; migration refused");
  db.exec(`UPDATE pending_actions SET verify_definition = verify_check, verify_check = NULL
    WHERE verify_check IS NOT NULL`);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS pending_check_legacy_insert
    BEFORE INSERT ON pending_actions WHEN NEW.verify_check IS NOT NULL BEGIN
      SELECT RAISE(ABORT, 'Legacy verification writes are disabled; update Kit to configure a local check');
    END;
    CREATE TRIGGER IF NOT EXISTS pending_check_legacy_update
    BEFORE UPDATE ON pending_actions WHEN NEW.verify_check IS NOT NULL BEGIN
      SELECT RAISE(ABORT, 'Legacy verification writes are disabled; update Kit to configure a local check');
    END;
  `);
}

/** Public inspection keeps its existing field; raw SQLite retains only the inert legacy slot. */
export function inspectAction(
  stored: Omit<PendingAction, "claim_owner"> & {
    claim_owner?: unknown;
    verify_definition?: string | null;
  },
): PendingAction {
  const { verify_definition, claim_owner, ...action } = stored;
  return {
    ...action,
    ...(claim_owner === undefined ? {} : { claim_owner: storedClaimOwner(claim_owner) }),
    verify_check: verify_definition === undefined ? action.verify_check : verify_definition,
  };
}

/** Read-only inspection of staged recovery bytes; legacy verifiers must not gain an execution slot. */
export function assertRecoveryCompatible(path: string): void {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const relation = db
      .prepare("PRAGMA table_list")
      .all()
      .find((row) => row.schema === "main" && String(row.name).toLowerCase() === "pending_actions");
    if (relation && relation.type !== "table") {
      throw new Error(
        "Non-table pending actions require safe import; use kit memory sync instead of raw restore",
      );
    }
    const columns = db.prepare("PRAGMA table_xinfo(pending_actions)").all();
    const legacy = ["verify_check", "verify_cmd"].filter((name) =>
      columns.some((column) => String(column.name).toLowerCase() === name),
    );
    if (!legacy.length) return;
    const predicate = legacy.map((column) => `${column} IS NOT NULL`).join(" OR ");
    if (db.prepare(`SELECT 1 FROM pending_actions WHERE ${predicate} LIMIT 1`).get()) {
      throw new Error(
        "Legacy verification data requires safe import; use kit memory sync instead of raw restore",
      );
    }
  } finally {
    db.close();
  }
}
