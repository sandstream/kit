import type { DatabaseSync } from "node:sqlite";

export const SCHEMA_VERSION = 17;

/** Unknown formats must not be interpreted as older stores or partially migrated. */
export function assertSupportedMemorySchema(db: DatabaseSync): number | undefined {
  const metadata = db
    .prepare("SELECT type FROM sqlite_master WHERE name='schema_meta' COLLATE NOCASE")
    .get();
  if (!metadata) return;
  const invalid = "Invalid memory schema version; recover from an intact store";
  if (metadata.type !== "table") throw new Error(invalid);
  let rows;
  try {
    rows = db.prepare("SELECT version AS version FROM schema_meta LIMIT 2").all();
  } catch {
    throw new Error(invalid);
  }
  if (
    rows.length !== 1 ||
    typeof rows[0].version !== "number" ||
    !Number.isSafeInteger(rows[0].version) ||
    rows[0].version < 1
  ) {
    throw new Error(invalid);
  }
  if (rows[0].version > SCHEMA_VERSION)
    throw new Error("Newer memory schema is not supported; update kit before opening this store");
  if (
    rows[0].version >= 16 &&
    !db
      .prepare("PRAGMA table_info(pending_actions)")
      .all()
      .some((column) => String(column.name).toLowerCase() === "claim_owner")
  )
    throw new Error("Claim ownership storage is missing; recover from an intact store");
  if (
    rows[0].version >= 17 &&
    !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_projects'").get()
  )
    throw new Error("Project identity storage is missing; recover from an intact store");
  return rows[0].version;
}
