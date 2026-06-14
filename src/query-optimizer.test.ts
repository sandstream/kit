import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { QueryOptimizer, type IndexDefinition } from "./query-optimizer.js";

describe("QueryOptimizer", () => {
  describe("index management", () => {
    let optimizer: QueryOptimizer;

    beforeEach(() => {
      optimizer = new QueryOptimizer();
    });

    it("creates an index", () => {
      const indexDef: IndexDefinition = {
        name: "idx_plugins_author",
        columns: ["author"],
        type: "btree",
        unique: false,
      };
      optimizer.createIndex(indexDef);
      assert.equal(optimizer.getIndex("idx_plugins_author"), indexDef);
    });

    it("retrieves index by name", () => {
      const indexDef: IndexDefinition = {
        name: "idx_plugins_name",
        columns: ["name"],
        type: "btree",
        unique: false,
      };
      optimizer.createIndex(indexDef);
      const retrieved = optimizer.getIndex("idx_plugins_name");
      assert(retrieved);
      assert.equal(retrieved.name, "idx_plugins_name");
    });

    it("returns null for unknown index", () => {
      const index = optimizer.getIndex("nonexistent");
      assert.equal(index, null);
    });

    it("gets all indexes", () => {
      optimizer.createIndex({
        name: "idx1",
        columns: ["col1"],
        type: "btree",
        unique: false,
      });
      optimizer.createIndex({
        name: "idx2",
        columns: ["col2"],
        type: "hash",
        unique: true,
      });
      const all = optimizer.getAllIndexes();
      assert.equal(all.length, 2);
    });

    it("drops an index", () => {
      optimizer.createIndex({
        name: "idx_temp",
        columns: ["temp"],
        type: "btree",
        unique: false,
      });
      const dropped = optimizer.dropIndex("idx_temp");
      assert(dropped);
      assert.equal(optimizer.getIndex("idx_temp"), null);
    });
  });

  describe("query planning", () => {
    let optimizer: QueryOptimizer;

    beforeEach(() => {
      optimizer = new QueryOptimizer();
      optimizer.createIndex({
        name: "idx_author",
        columns: ["author"],
        type: "btree",
        unique: false,
      });
    });

    it("generates query plan", () => {
      const plan = optimizer.planQuery("SELECT * FROM plugins WHERE author = ?", [
        "author",
      ]);
      assert(plan);
      assert(plan.estimatedCost > 0);
      assert(plan.batchSize > 0);
    });

    it("uses applicable indexes in plan", () => {
      const plan = optimizer.planQuery("SELECT * FROM plugins WHERE author = ?", [
        "author",
      ]);
      assert(plan.indexesUsed.includes("idx_author"));
    });

    it("caches query plans", () => {
      const query = "SELECT * FROM plugins";
      const plan1 = optimizer.planQuery(query);
      const plan2 = optimizer.planQuery(query);
      assert.equal(plan1, plan2);
    });

    it("recommends larger batch sizes for simple queries", () => {
      const simplePlan = optimizer.planQuery(
        "SELECT * FROM plugins LIMIT 100",
      );
      assert(simplePlan.batchSize >= 100);
    });

    it("recommends smaller batch sizes for complex queries", () => {
      const complexPlan = optimizer.planQuery(
        "SELECT * FROM plugins JOIN authors ON plugins.author = authors.id WHERE plugins.downloads > 1000",
      );
      assert(complexPlan.batchSize <= 100);
    });

    it("sets useConnection flag for expensive queries", () => {
      const expensivePlan = optimizer.planQuery(
        "SELECT * FROM plugins JOIN authors ON plugins.author = authors.id GROUP BY category ORDER BY downloads DESC",
      );
      assert(expensivePlan.useConnection);
    });

    it("gets cached plan", () => {
      const query = "SELECT * FROM plugins";
      optimizer.planQuery(query);
      const cached = optimizer.getCachedPlan(query);
      assert(cached);
    });

    it("clears query cache", () => {
      optimizer.planQuery("SELECT * FROM plugins");
      optimizer.clearCache();
      const cached = optimizer.getCachedPlan("SELECT * FROM plugins");
      assert.equal(cached, null);
    });
  });

  describe("query execution", () => {
    let optimizer: QueryOptimizer;

    beforeEach(() => {
      optimizer = new QueryOptimizer();
    });

    it("executes query and returns result", () => {
      const result = optimizer.executeQuery("SELECT * FROM plugins");
      assert(result.rows !== undefined);
      assert(result.executionTime >= 0);
    });

    it("tracks execution time", () => {
      optimizer.executeQuery("SELECT * FROM plugins");
      const stats = optimizer.getExecutionStats();
      assert(stats.length > 0);
      assert(stats[0].executionTime >= 0);
    });

    it("gets execution statistics", () => {
      optimizer.executeQuery("SELECT * FROM plugins");
      optimizer.executeQuery("SELECT * FROM authors");
      const stats = optimizer.getExecutionStats();
      assert(stats.length >= 2);
    });

    it("calculates average execution time", () => {
      optimizer.executeQuery("SELECT * FROM plugins");
      optimizer.executeQuery("SELECT * FROM plugins");
      const avg = optimizer.getAverageExecutionTime("SELECT * FROM plugins");
      assert(avg >= 0);
    });

    it("calculates average for all queries", () => {
      optimizer.executeQuery("SELECT * FROM plugins");
      optimizer.executeQuery("SELECT * FROM authors");
      const avg = optimizer.getAverageExecutionTime();
      assert(avg >= 0);
    });
  });

  describe("batch operations", () => {
    let optimizer: QueryOptimizer;

    beforeEach(() => {
      optimizer = new QueryOptimizer();
    });

    it("queues batch operation", () => {
      const operations = [
        { type: "insert" as const, data: { name: "Plugin 1" } },
        { type: "insert" as const, data: { name: "Plugin 2" } },
      ];
      const batch = optimizer.queueBatchOperation("batch-1", operations);
      assert.equal(batch.id, "batch-1");
      assert.equal(batch.status, "pending");
    });

    it("executes batch operation", () => {
      const operations = [
        { type: "insert" as const, data: { name: "Plugin 1" } },
        { type: "update" as const, data: { id: "1" } },
        { type: "delete" as const, data: { id: "2" } },
      ];
      optimizer.queueBatchOperation("batch-1", operations);
      const executed = optimizer.executeBatch("batch-1");
      assert(executed);
      assert.equal(executed.status, "completed");
    });

    it("gets batch operation by ID", () => {
      const operations = [
        { type: "insert" as const, data: { name: "Plugin" } },
      ];
      optimizer.queueBatchOperation("batch-1", operations);
      const batch = optimizer.getBatchOperation("batch-1");
      assert(batch);
      assert.equal(batch.id, "batch-1");
    });

    it("returns null for unknown batch", () => {
      const batch = optimizer.getBatchOperation("unknown");
      assert.equal(batch, null);
    });

    it("tracks pending batches", () => {
      optimizer.queueBatchOperation("batch-1", [
        { type: "insert" as const, data: {} },
      ]);
      optimizer.queueBatchOperation("batch-2", [
        { type: "insert" as const, data: {} },
      ]);
      const pending = optimizer.getPendingBatches();
      assert.equal(pending.length, 2);
    });

    it("removes pending status after execution", () => {
      optimizer.queueBatchOperation("batch-1", [
        { type: "insert" as const, data: {} },
      ]);
      optimizer.executeBatch("batch-1");
      const pending = optimizer.getPendingBatches();
      assert.equal(pending.length, 0);
    });
  });

  describe("cache info", () => {
    let optimizer: QueryOptimizer;

    beforeEach(() => {
      optimizer = new QueryOptimizer();
    });

    it("returns index cache size", () => {
      optimizer.createIndex({
        name: "idx1",
        columns: ["col1"],
        type: "btree",
        unique: false,
      });
      const indexes = optimizer.getIndexCache();
      assert.equal(indexes.size, 1);
    });

    it("returns query cache size", () => {
      optimizer.planQuery("SELECT * FROM plugins");
      optimizer.planQuery("SELECT * FROM authors");
      const size = optimizer.getQueryCacheSize();
      assert.equal(size, 2);
    });

    it("returns batch queue size", () => {
      optimizer.queueBatchOperation("batch-1", [
        { type: "insert" as const, data: {} },
      ]);
      optimizer.queueBatchOperation("batch-2", [
        { type: "insert" as const, data: {} },
      ]);
      const size = optimizer.getBatchQueueSize();
      assert.equal(size, 2);
    });
  });
});
