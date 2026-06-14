import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { CacheManager, type CacheConfig } from "./cache-manager.js";

describe("CacheManager", () => {
  describe("basic operations", () => {
    let manager: CacheManager;

    beforeEach(() => {
      manager = new CacheManager();
    });

    it("sets and gets a cache entry", () => {
      manager.set("key1", { value: "test" });
      const result = manager.get("key1");
      assert.deepEqual(result, { value: "test" });
    });

    it("returns null for unknown key", () => {
      const result = manager.get("unknown");
      assert.equal(result, null);
    });

    it("checks if key exists", () => {
      manager.set("key1", "value1");
      assert(manager.has("key1"));
      assert(!manager.has("unknown"));
    });

    it("deletes a cache entry", () => {
      manager.set("key1", "value1");
      const deleted = manager.delete("key1");
      assert(deleted);
      assert.equal(manager.get("key1"), null);
    });

    it("clears all entries", () => {
      manager.set("key1", "value1");
      manager.set("key2", "value2");
      manager.clear();
      assert.equal(manager.get("key1"), null);
      assert.equal(manager.get("key2"), null);
    });

    it("tracks hits and misses", () => {
      manager.set("key1", "value1");
      manager.get("key1");
      manager.get("unknown");
      assert.equal(manager.getHits(), 1);
      assert.equal(manager.getMisses(), 1);
    });
  });

  describe("expiration", () => {
    let manager: CacheManager;

    beforeEach(() => {
      manager = new CacheManager({ maxSize: 100, defaultTtl: 3600, strategy: "lru" });
    });

    it("expires entries with TTL", (t, done) => {
      const ttl = 1; // 1 second
      manager.set("key1", "value1", ttl);
      assert(manager.has("key1"));

      setTimeout(() => {
        assert(!manager.has("key1"));
        done?.();
      }, 1100);
    });

    it("does not expire entries without TTL", () => {
      manager.set("key1", "value1");
      assert(manager.has("key1"));
    });

    it("cleans expired entries", (t, done) => {
      manager.set("key1", "value1", 1);
      manager.set("key2", "value2");

      setTimeout(() => {
        const cleaned = manager.cleanExpired();
        assert(cleaned > 0);
        assert(!manager.has("key1"));
        assert(manager.has("key2"));
        done?.();
      }, 1100);
    });
  });

  describe("invalidation", () => {
    let manager: CacheManager;

    beforeEach(() => {
      manager = new CacheManager();
      manager.set("user:1:profile", { id: 1 });
      manager.set("user:1:settings", { theme: "dark" });
      manager.set("user:2:profile", { id: 2 });
      manager.set("plugin:stripe", { name: "stripe" });
    });

    it("invalidates by pattern", () => {
      const invalidated = manager.invalidatePattern("user:1:.*");
      assert(invalidated > 0);
      assert(!manager.has("user:1:profile"));
      assert(!manager.has("user:1:settings"));
      assert(manager.has("user:2:profile"));
    });

    it("invalidates by prefix", () => {
      const invalidated = manager.invalidatePrefix("user:1:");
      assert.equal(invalidated, 2);
      assert(!manager.has("user:1:profile"));
      assert(!manager.has("user:1:settings"));
      assert(manager.has("user:2:profile"));
    });
  });

  describe("eviction strategies", () => {
    it("uses LRU eviction when at capacity", () => {
      const manager = new CacheManager({
        maxSize: 3,
        defaultTtl: 3600,
        strategy: "lru",
      });

      manager.set("key1", "value1");
      manager.set("key2", "value2");
      manager.set("key3", "value3");

      // Access key1 to increase its hit count
      manager.get("key1");
      manager.get("key1");

      // Add new entry - should evict key2 or key3 (not key1)
      manager.set("key4", "value4");

      // key1 should still be there due to higher hit count
      assert(manager.has("key1"));
      assert.equal(manager.getCacheMap().size, 3);
    });

    it("uses FIFO eviction when at capacity", () => {
      const manager = new CacheManager({
        maxSize: 2,
        defaultTtl: 3600,
        strategy: "fifo",
      });

      manager.set("key1", "value1");
      manager.set("key2", "value2");
      manager.set("key3", "value3"); // Should evict key1

      assert(!manager.has("key1"));
      assert(manager.has("key2"));
      assert(manager.has("key3"));
    });

    it("tracks evictions", () => {
      const manager = new CacheManager({
        maxSize: 2,
        defaultTtl: 3600,
        strategy: "lru",
      });

      manager.set("key1", "value1");
      manager.set("key2", "value2");
      manager.set("key3", "value3");

      const stats = manager.getStats();
      assert(stats.evictions > 0);
    });
  });

  describe("statistics", () => {
    let manager: CacheManager;

    beforeEach(() => {
      manager = new CacheManager();
    });

    it("returns cache statistics", () => {
      manager.set("key1", "value1");
      manager.get("key1");
      manager.get("unknown");

      const stats = manager.getStats();
      assert.equal(stats.totalEntries, 1);
      assert(stats.hitRate > 0);
      assert(stats.hitRate <= 1);
    });

    it("calculates hit rate", () => {
      manager.set("key1", "value1");
      manager.get("key1");
      manager.get("key1");
      manager.get("unknown");

      const hitRate = manager.getHitRate();
      assert(hitRate > 0);
      assert(hitRate <= 100);
    });

    it("returns empty hit rate for no requests", () => {
      const hitRate = manager.getHitRate();
      assert.equal(hitRate, 0);
    });
  });

  describe("inspection", () => {
    let manager: CacheManager;

    beforeEach(() => {
      manager = new CacheManager();
      manager.set("key1", "value1");
      manager.set("key2", { count: 2 });
    });

    it("gets all cache keys", () => {
      const keys = manager.getKeys();
      assert(keys.includes("key1"));
      assert(keys.includes("key2"));
    });

    it("gets cache entry details", () => {
      manager.get("key1"); // increment hits
      const entry = manager.getEntry("key1");
      assert(entry);
      assert.equal(entry.key, "key1");
      assert.equal(entry.hits, 1);
    });

    it("gets all entries", () => {
      const entries = manager.getAllEntries();
      assert.equal(entries.length, 2);
    });

    it("estimates cache size", () => {
      manager.set("large_key", { data: "x".repeat(1000) });
      const size = manager.getApproximateSize();
      assert(size > 0);
    });
  });

  describe("configuration", () => {
    it("uses custom config", () => {
      const config: CacheConfig = {
        maxSize: 500,
        defaultTtl: 7200,
        strategy: "lfu",
      };
      const manager = new CacheManager(config);
      const returnedConfig = manager.getConfig();
      assert.deepEqual(returnedConfig, config);
    });

    it("uses default config when not provided", () => {
      const manager = new CacheManager();
      const config = manager.getConfig();
      assert.equal(config.maxSize, 1000);
      assert.equal(config.defaultTtl, 3600);
    });
  });
});
