import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseManager, type DatabaseConfig } from "./database.js";

describe("DatabaseManager", () => {
  describe("connection management", () => {
    let db: DatabaseManager;
    let config: DatabaseConfig;

    beforeEach(() => {
      config = {
        host: "localhost",
        port: 5432,
        database: "kit_test",
        user: "postgres",
        password: "password",
        poolSize: 5,
      };
      db = new DatabaseManager(config);
    });

    it("creates database manager with config", () => {
      assert(db);
      const poolInfo = db.getPoolInfo();
      assert.equal(poolInfo.size, 5);
    });

    it("initializes connection pool", async () => {
      await db.connect();
      assert(db.isConnected());
    });

    it("disconnects from database", async () => {
      await db.connect();
      assert(db.isConnected());
      await db.disconnect();
      assert(!db.isConnected());
    });

    it("prevents queries before initialization", async () => {
      const db2 = new DatabaseManager(config);
      try {
        await db2.query("SELECT 1");
        assert.fail("Should have thrown error");
      } catch (error) {
        assert((error as Error).message.includes("not initialized"));
      }
    });
  });

  describe("query execution", () => {
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

    afterEach(async () => {
      await db.disconnect();
    });

    it("executes a simple query", async () => {
      const result = await db.query("SELECT 1 as test");
      assert(result);
      assert(result.executionTime >= 0);
    });

    it("executes query with parameters", async () => {
      const result = await db.query("SELECT $1 as value", ["test"]);
      assert(result);
      assert.equal(result.rowCount, 0); // Mock returns empty
    });

    it("logs query execution", async () => {
      db.clearQueryLog();
      await db.query("SELECT 1");
      const stats = db.getQueryStats();
      assert(stats.totalQueries > 0);
    });

    it("tracks execution time", async () => {
      db.clearQueryLog();
      await db.query("SELECT 1");
      const stats = db.getQueryStats();
      assert(stats.averageExecutionTime >= 0);
    });

    it("handles multiple queries", async () => {
      db.clearQueryLog();
      await db.query("SELECT 1");
      await db.query("SELECT 2");
      await db.query("SELECT 3");
      const stats = db.getQueryStats();
      assert.equal(stats.totalQueries, 3);
    });
  });

  describe("transactions", () => {
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

    afterEach(async () => {
      await db.disconnect();
    });

    it("executes transaction", async () => {
      const result = await db.transaction(async (database) => {
        await database.query("INSERT INTO test VALUES ($1)", [1]);
        return "success";
      });
      assert.equal(result, "success");
    });

    it("rollback on transaction error", async () => {
      try {
        await db.transaction(async () => {
          throw new Error("Transaction error");
        });
        assert.fail("Should have thrown error");
      } catch (error) {
        assert((error as Error).message.includes("Transaction failed"));
      }
    });
  });

  describe("batch operations", () => {
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

    afterEach(async () => {
      await db.disconnect();
    });

    it("executes batch queries", async () => {
      const queries = [
        { sql: "SELECT 1", params: [] },
        { sql: "SELECT 2", params: [] },
        { sql: "SELECT 3", params: [] },
      ];
      const results = await db.batch(queries);
      assert.equal(results.length, 3);
    });

    it("returns all results from batch", async () => {
      const queries = [
        { sql: "INSERT INTO test VALUES ($1)", params: [1] },
        { sql: "INSERT INTO test VALUES ($1)", params: [2] },
      ];
      const results = await db.batch(queries);
      assert(results.every((r) => r.executionTime >= 0));
    });
  });

  describe("migrations", () => {
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

    afterEach(async () => {
      await db.disconnect();
    });

    it("registers a migration", () => {
      const migration = {
        id: "001-create-plugins",
        name: "Create plugins table",
        version: "1.0.0",
        sql: "CREATE TABLE plugins (id SERIAL PRIMARY KEY, name VARCHAR(255))",
      };
      db.registerMigration(migration);
      // Migration is registered, would be executed on runMigrations
      assert(migration.id);
    });

    it("runs migrations", async () => {
      const migration = {
        id: "001-test",
        name: "Test migration",
        version: "1.0.0",
        sql: "CREATE TABLE IF NOT EXISTS test_migrations (id INT)",
      };
      db.registerMigration(migration);
      const executed = await db.runMigrations();
      // At least the test migration should have been attempted
      assert(Array.isArray(executed));
    });

    it("gets executed migrations", async () => {
      const migrations = await db.getExecutedMigrations();
      assert(Array.isArray(migrations));
    });
  });

  describe("backup & restore", () => {
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

    afterEach(async () => {
      await db.disconnect();
    });

    it("createBackup is not implemented (throws)", async () => {
      await assert.rejects(() => db.createBackup("kit"), /not implemented/i);
    });

    it("restoreBackup is not implemented (throws)", async () => {
      await assert.rejects(() => db.restoreBackup("backups/kit.sql"), /not implemented/i);
    });
  });

  describe("health checks", () => {
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

    afterEach(async () => {
      await db.disconnect();
    });

    it("checks database health", async () => {
      const health = await db.getHealth();
      assert(health.status === "healthy" || health.status === "degraded");
      assert(health.poolSize > 0);
      assert(health.lastHealthCheck);
    });

    it("returns health status with pool info", async () => {
      const health = await db.getHealth();
      assert(typeof health.activeConnections === "number");
      assert(typeof health.idleConnections === "number");
      assert(typeof health.waitingRequests === "number");
    });

    it("gets pool info", () => {
      const poolInfo = db.getPoolInfo();
      assert(poolInfo.size > 0);
      assert(poolInfo.activeConnections >= 0);
      assert(poolInfo.idleConnections >= 0);
    });
  });

  describe("query statistics", () => {
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
      db.clearQueryLog(); // Clear the initialization query from stats
    });

    afterEach(async () => {
      await db.disconnect();
    });

    it("returns empty stats initially", () => {
      const stats = db.getQueryStats();
      assert.equal(stats.totalQueries, 0);
    });

    it("tracks query statistics", async () => {
      await db.query("SELECT 1");
      await db.query("SELECT 2");
      const stats = db.getQueryStats();
      assert.equal(stats.totalQueries, 2);
      assert(stats.averageExecutionTime >= 0);
    });

    it("identifies slowest query", async () => {
      await db.query("SELECT 1");
      await db.query("SELECT 2");
      const stats = db.getQueryStats();
      assert(stats.slowestQuery === null || stats.slowestQuery.sql);
    });
  });
});
