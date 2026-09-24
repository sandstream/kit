import type { DatabaseSync } from "node:sqlite";

/** Local invalidation, not causal history. Replacing an action row cannot supply its version. */
export function prepareActionVersion(db: DatabaseSync): void {
  db.exec(`
    DROP TRIGGER IF EXISTS pending_mutation_insert;
    DROP TRIGGER IF EXISTS pending_mutation_update;
    CREATE TABLE IF NOT EXISTS pending_action_versions (
      action_id TEXT PRIMARY KEY, token TEXT NOT NULL
    );
    INSERT INTO pending_action_versions
      SELECT id, lower(hex(randomblob(16))) FROM pending_actions
      WHERE NOT EXISTS (SELECT 1 FROM pending_action_versions WHERE action_id = id);
    DELETE FROM pending_action_versions
      WHERE NOT EXISTS (SELECT 1 FROM pending_actions WHERE id = action_id);
    CREATE TRIGGER IF NOT EXISTS pending_version_insert AFTER INSERT ON pending_actions BEGIN
      INSERT OR REPLACE INTO pending_action_versions VALUES (new.id, lower(hex(randomblob(16))));
    END;
    CREATE TRIGGER IF NOT EXISTS pending_version_update AFTER UPDATE ON pending_actions BEGIN
      DELETE FROM pending_action_versions WHERE action_id = old.id;
      INSERT OR REPLACE INTO pending_action_versions VALUES (new.id, lower(hex(randomblob(16))));
    END;
    CREATE TRIGGER IF NOT EXISTS pending_version_delete AFTER DELETE ON pending_actions BEGIN
      DELETE FROM pending_action_versions WHERE action_id = old.id;
    END;
  `);
}
