// ─── Migration Runner ────────────────────────────────────────────────────────

import { DatabaseManager } from "./database.js";
import { MIGRATIONS } from "./migrations.js";

/**
 * Migration runner with status tracking and rollback support.
 */
export class MigrationRunner {
  private db: DatabaseManager;
  private executedMigrations: Set<string> = new Set();

  constructor(db: DatabaseManager) {
    this.db = db;
  }

  /**
   * Initialize migration tracking tables and load executed migrations.
   */
  async init(): Promise<void> {
    // Create migrations table if not exists
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        version VARCHAR(20) NOT NULL,
        executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        rolled_back_at TIMESTAMP,
        execution_time INTEGER,
        status VARCHAR(20) DEFAULT 'success'
      )
    `);

    // Load executed migrations
    const result = await this.db.query(
      "SELECT id FROM schema_migrations WHERE rolled_back_at IS NULL AND status = 'success'",
    );

    for (const row of result.rows) {
      this.executedMigrations.add((row as any).id);
    }
  }

  /**
   * Get list of pending migrations.
   */
  getPendingMigrations(): typeof MIGRATIONS {
    return MIGRATIONS.filter((m) => !this.executedMigrations.has(m.id));
  }

  /**
   * Get list of executed migrations.
   */
  getExecutedMigrations(): typeof MIGRATIONS {
    return MIGRATIONS.filter((m) => this.executedMigrations.has(m.id));
  }

  /**
   * Run all pending migrations.
   */
  async runPending(): Promise<{
    executed: number;
    failed: number;
    total: number;
    errors: Array<{ migration: string; error: string }>;
  }> {
    await this.init();

    const pending = this.getPendingMigrations();
    const errors: Array<{ migration: string; error: string }> = [];
    let executed = 0;

    for (const migration of pending) {
      try {
        const startTime = Date.now();

        // Execute migration in transaction
        await this.db.transaction(async (db) => {
          await db.query(migration.sql);
          await db.query(
            `INSERT INTO schema_migrations (id, name, version, execution_time, status)
             VALUES ($1, $2, $3, $4, 'success')`,
            [migration.id, migration.name, migration.version, Date.now() - startTime],
          );
        });

        this.executedMigrations.add(migration.id);
        executed++;

        console.log(`✓ ${migration.name}`);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        errors.push({
          migration: migration.name,
          error: errorMsg,
        });

        // Mark as failed
        await this.db.query(
          `INSERT INTO schema_migrations (id, name, version, status)
           VALUES ($1, $2, $3, 'failed')`,
          [migration.id, migration.name, migration.version],
        );

        console.error(`✗ ${migration.name}: ${errorMsg}`);
      }
    }

    return {
      executed,
      failed: errors.length,
      total: pending.length,
      errors,
    };
  }

  /**
   * Run a specific migration by ID.
   */
  async runMigration(migrationId: string): Promise<{ success: boolean; error?: string }> {
    await this.init();

    const migration = MIGRATIONS.find((m) => m.id === migrationId);
    if (!migration) {
      return { success: false, error: `Migration ${migrationId} not found` };
    }

    if (this.executedMigrations.has(migrationId)) {
      return { success: false, error: `Migration ${migrationId} already executed` };
    }

    try {
      const startTime = Date.now();

      await this.db.transaction(async (db) => {
        await db.query(migration.sql);
        await db.query(
          `INSERT INTO schema_migrations (id, name, version, execution_time, status)
           VALUES ($1, $2, $3, $4, 'success')`,
          [migration.id, migration.name, migration.version, Date.now() - startTime],
        );
      });

      this.executedMigrations.add(migrationId);
      console.log(`✓ ${migration.name}`);
      return { success: true };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await this.db.query(
        `INSERT INTO schema_migrations (id, name, version, status)
         VALUES ($1, $2, $3, 'failed')`,
        [migration.id, migration.name, migration.version],
      );

      console.error(`✗ ${migration.name}: ${errorMsg}`);
      return { success: false, error: errorMsg };
    }
  }

  /**
   * Get migration status summary.
   */
  async getStatus(): Promise<{
    executed: number;
    pending: number;
    failed: number;
    total: number;
  }> {
    await this.init();

    const failedResult = await this.db.query(
      "SELECT COUNT(*) as count FROM schema_migrations WHERE status = 'failed'",
    );
    const failedCount = (failedResult.rows[0] as any)?.count || 0;

    return {
      executed: this.executedMigrations.size,
      pending: this.getPendingMigrations().length,
      failed: failedCount,
      total: MIGRATIONS.length,
    };
  }

  /**
   * Print migration report to console.
   */
  async printReport(): Promise<void> {
    const status = await this.getStatus();
    const executed = this.getExecutedMigrations();
    const pending = this.getPendingMigrations();

    console.log("\n┌─ Migration Status ─────────────────────────────────────────┐");
    console.log(`│ Executed: ${String(status.executed).padEnd(50)} │`);
    console.log(`│ Pending:  ${String(status.pending).padEnd(50)} │`);
    console.log(`│ Failed:   ${String(status.failed).padEnd(50)} │`);
    console.log(`│ Total:    ${String(status.total).padEnd(50)} │`);
    console.log("└────────────────────────────────────────────────────────────┘\n");

    if (executed.length > 0) {
      console.log("Executed Migrations:");
      for (const m of executed) {
        console.log(`  ✓ ${m.id}: ${m.name}`);
      }
      console.log();
    }

    if (pending.length > 0) {
      console.log("Pending Migrations:");
      for (const m of pending) {
        console.log(`  ○ ${m.id}: ${m.name}`);
      }
      console.log();
    }
  }
}

/**
 * Create backup before migrations.
 */
export async function createPreMigrationBackup(db: DatabaseManager): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupName = `pre-migration-${timestamp}`;
  const result = await db.createBackup(backupName);
  return result.backupFile;
}

/**
 * Run migrations with backup strategy.
 */
export async function runMigrationsWithBackup(
  db: DatabaseManager,
): Promise<{ success: boolean; backupFile?: string; errors?: string[] }> {
  // Create backup
  const backupFile = await createPreMigrationBackup(db);
  console.log(`Backup created: ${backupFile}`);

  // Run migrations
  const runner = new MigrationRunner(db);
  const result = await runner.runPending();

  if (result.failed > 0) {
    console.error("\nMigrations failed! Consider restoring backup:");
    console.error(`  db.restoreBackup('${backupFile}')`);

    return {
      success: false,
      backupFile,
      errors: result.errors.map((e) => `${e.migration}: ${e.error}`),
    };
  }

  console.log(`\n${result.executed} migrations executed successfully`);
  await runner.printReport();

  return { success: true, backupFile };
}
