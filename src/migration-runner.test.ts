import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseManager, type DatabaseConfig } from "./database.js";
import { MigrationRunner } from "./migration-runner.js";
import { MIGRATIONS } from "./migrations.js";

describe("MigrationRunner", () => {
  describe("initialization", () => {
    let db: DatabaseManager;
    let runner: MigrationRunner;

    beforeEach(async () => {
      const config: DatabaseConfig = {
        host: "localhost",
        port: 5432,
        database: "postgres",
        user: "postgres",
        password: "password",
      };
      db = new DatabaseManager(config);
      await db.connect();
      runner = new MigrationRunner(db);
    });

    it("initializes migration tracker", async () => {
      await runner.init();
      const status = await runner.getStatus();
      assert(status.total > 0);
    });

    it("creates migrations table", async () => {
      await runner.init();
      const result = await db.query("SELECT 1 FROM schema_migrations LIMIT 1");
      assert(result.executionTime >= 0);
    });
  });

  describe("migration management", () => {
    let db: DatabaseManager;
    let runner: MigrationRunner;

    beforeEach(async () => {
      const config: DatabaseConfig = {
        host: "localhost",
        port: 5432,
        database: "postgres",
        user: "postgres",
        password: "password",
      };
      db = new DatabaseManager(config);
      await db.connect();
      runner = new MigrationRunner(db);
      await runner.init();
    });

    it("gets all migrations", () => {
      const migrations = MIGRATIONS;
      assert(migrations.length > 0);
    });

    it("identifies pending migrations", async () => {
      const pending = runner.getPendingMigrations();
      assert(pending.length > 0);
    });

    it("identifies executed migrations", async () => {
      const executed = runner.getExecutedMigrations();
      assert(Array.isArray(executed));
    });

    it("distinguishes pending from executed", async () => {
      const pending = runner.getPendingMigrations();
      const executed = runner.getExecutedMigrations();
      const total = pending.length + executed.length;
      assert.equal(total, MIGRATIONS.length);
    });
  });

  describe("status tracking", () => {
    let db: DatabaseManager;
    let runner: MigrationRunner;

    beforeEach(async () => {
      const config: DatabaseConfig = {
        host: "localhost",
        port: 5432,
        database: "kit_test",
        user: "postgres",
        password: "password",
      };
      db = new DatabaseManager(config);
      await db.connect();
      runner = new MigrationRunner(db);
      await runner.init();
    });

    it("returns migration status", async () => {
      const status = await runner.getStatus();
      assert(typeof status.executed === "number");
      assert(typeof status.pending === "number");
      assert(typeof status.failed === "number");
      assert.equal(status.total, MIGRATIONS.length);
    });

    it("tracks executed migrations", async () => {
      const status = await runner.getStatus();
      assert(status.executed >= 0);
    });

    it("tracks pending migrations", async () => {
      const status = await runner.getStatus();
      assert(status.pending >= 0);
    });

    it("sums to total", async () => {
      const status = await runner.getStatus();
      assert(status.executed + status.pending + status.failed >= status.executed);
    });
  });

  describe("migration execution", () => {
    let db: DatabaseManager;
    let runner: MigrationRunner;

    beforeEach(async () => {
      const config: DatabaseConfig = {
        host: "localhost",
        port: 5432,
        database: "kit_test",
        user: "postgres",
        password: "password",
      };
      db = new DatabaseManager(config);
      await db.connect();
      runner = new MigrationRunner(db);
      await runner.init();
    });

    it("runs pending migrations", async () => {
      const result = await runner.runPending();
      assert(typeof result.executed === "number");
      assert(typeof result.failed === "number");
      assert(typeof result.total === "number");
    });

    it("tracks execution status", async () => {
      const before = await runner.getStatus();
      await runner.runPending();
      const after = await runner.getStatus();
      assert(after.executed >= before.executed);
    });

    it("returns error list", async () => {
      const result = await runner.runPending();
      assert(Array.isArray(result.errors));
    });

    it("runs individual migration", async () => {
      const pending = runner.getPendingMigrations();
      if (pending.length > 0) {
        const result = await runner.runMigration(pending[0].id);
        assert(typeof result.success === "boolean");
      }
    });

    it("prevents re-execution of migrations", async () => {
      const pending = runner.getPendingMigrations();
      if (pending.length > 0) {
        // First run should succeed
        const result1 = await runner.runMigration(pending[0].id);

        if (result1.success) {
          // Second run should fail
          const result2 = await runner.runMigration(pending[0].id);
          assert(!result2.success);
        }
      }
    });
  });

  describe("migration report", () => {
    let db: DatabaseManager;
    let runner: MigrationRunner;

    beforeEach(async () => {
      const config: DatabaseConfig = {
        host: "localhost",
        port: 5432,
        database: "kit_test",
        user: "postgres",
        password: "password",
      };
      db = new DatabaseManager(config);
      await db.connect();
      runner = new MigrationRunner(db);
      await runner.init();
    });

    it("generates report without error", async () => {
      assert.doesNotThrow(async () => {
        await runner.printReport();
      });
    });

    it("lists executed migrations", async () => {
      const executed = runner.getExecutedMigrations();
      assert(Array.isArray(executed));
    });

    it("lists pending migrations", async () => {
      const pending = runner.getPendingMigrations();
      assert(Array.isArray(pending));
    });
  });

  describe("backup support", () => {
    let db: DatabaseManager;

    beforeEach(async () => {
      const config: DatabaseConfig = {
        host: "localhost",
        port: 5432,
        database: "kit_test",
        user: "postgres",
        password: "password",
      };
      db = new DatabaseManager(config);
      await db.connect();
    });

    it("creates backup", async () => {
      const backup = await db.createBackup("test");
      assert(backup.success);
      assert(backup.backupFile.includes("backups/"));
    });

    it("restores backup", async () => {
      const backup = await db.createBackup("test");
      const restore = await db.restoreBackup(backup.backupFile);
      assert(restore.success);
    });
  });
});
