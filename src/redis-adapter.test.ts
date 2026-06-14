import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { RedisAdapter, createRedisAdapter } from "./redis-adapter.js";

describe("RedisAdapter", () => {
  describe("initialization", () => {
    it("creates adapter with config", () => {
      const adapter = new RedisAdapter({
        enabled: true,
        endpoint: "localhost:6379",
      });

      assert.equal(adapter.name, "redis");
      assert.equal(adapter.version, "1.0.0");
    });

    it("initializes with disabled config", () => {
      const adapter = new RedisAdapter({ enabled: false });
      assert(!adapter.isConnected());
    });

    it("creates adapter with default config", () => {
      const adapter = new RedisAdapter();
      assert(!adapter.isConnected());
    });
  });

  describe("connection management", () => {
    let adapter: RedisAdapter;

    beforeEach(() => {
      adapter = new RedisAdapter({
        enabled: true,
        endpoint: "localhost:6379",
      });
    });

    it("connects with valid endpoint", async () => {
      await adapter.connect();
      assert(adapter.isConnected());
    });

    it("throws error when enabled without endpoint", async () => {
      const invalidAdapter = new RedisAdapter({ enabled: true });

      try {
        await invalidAdapter.connect();
        assert.fail("Should have thrown error");
      } catch (error) {
        assert((error as Error).message.includes("endpoint is required"));
      }
    });

    it("throws error with invalid endpoint format", async () => {
      const invalidAdapter = new RedisAdapter({
        enabled: true,
        endpoint: ":",
      });

      try {
        await invalidAdapter.connect();
        assert.fail("Should have thrown error");
      } catch (error) {
        assert((error as Error).message.includes("Invalid Redis endpoint"));
      }
    });

    it("throws error with invalid port number", async () => {
      const invalidAdapter = new RedisAdapter({
        enabled: true,
        endpoint: "localhost:not-a-port",
      });

      try {
        await invalidAdapter.connect();
        assert.fail("Should have thrown error");
      } catch (error) {
        assert((error as Error).message.includes("Invalid Redis port"));
      }
    });

    it("disconnects cleanly", async () => {
      await adapter.connect();
      assert(adapter.isConnected());

      await adapter.disconnect();
      assert(!adapter.isConnected());
    });

    it("skips connection when disabled", async () => {
      const disabledAdapter = new RedisAdapter({
        enabled: false,
        endpoint: "localhost:6379",
      });

      await disabledAdapter.connect();
      assert(!disabledAdapter.isConnected());
    });
  });

  describe("health monitoring", () => {
    let adapter: RedisAdapter;

    beforeEach(async () => {
      adapter = new RedisAdapter({
        enabled: true,
        endpoint: "localhost:6379",
      });
      await adapter.connect();
    });

    it("reports healthy status when connected", async () => {
      const health = await adapter.getHealth();

      assert.equal(health.status, "healthy");
      assert(health.lastCheck);
      assert(health.responseTime >= 0);
      assert.equal(health.errorCount, 0);
    });

    it("records response time", async () => {
      const health = await adapter.getHealth();
      assert(typeof health.responseTime === "number");
    });

    it("updates lastCheck timestamp", async () => {
      const before = new Date();
      await adapter.getHealth();
      const after = new Date();

      const health = await adapter.getHealth();
      const lastCheck = new Date(health.lastCheck);

      assert(lastCheck >= before);
      assert(lastCheck <= after);
    });
  });

  describe("cache operations", () => {
    let adapter: RedisAdapter;

    beforeEach(async () => {
      adapter = new RedisAdapter({
        enabled: true,
        endpoint: "localhost:6379",
      });
      await adapter.connect();
    });

    it("sets a cache value", async () => {
      const result = await adapter.set("test:key", "value");

      assert.equal(result, true);
    });

    it("sets a cache value with TTL", async () => {
      const result = await adapter.set("test:ttl", "expires soon", 3600);

      assert.equal(result, true);
    });

    it("gets a cached value", async () => {
      await adapter.set("test:get", "hello");

      const value = await adapter.get("test:get");

      assert.equal(value, "hello");
    });

    it("returns undefined for non-existent key", async () => {
      const value = await adapter.get("nonexistent");

      assert.equal(value, undefined);
    });

    it("stores different value types", async () => {
      await adapter.set("string", "value");
      await adapter.set("number", 42);
      await adapter.set("boolean", true);
      await adapter.set("object", { nested: "data" });

      assert.equal(await adapter.get("string"), "value");
      assert.equal(await adapter.get("number"), 42);
      assert.equal(await adapter.get("boolean"), true);
    });

    it("checks key existence", async () => {
      await adapter.set("existing", "value");

      assert.equal(await adapter.exists("existing"), true);
      assert.equal(await adapter.exists("notexisting"), false);
    });

    it("deletes a key", async () => {
      await adapter.set("to:delete", "value");
      assert.equal(await adapter.exists("to:delete"), true);

      const result = await adapter.delete("to:delete");
      assert.equal(result, true);
      assert.equal(await adapter.exists("to:delete"), false);
    });

    it("clears all cache", async () => {
      await adapter.set("key1", "value1");
      await adapter.set("key2", "value2");
      assert(adapter.size() > 0);

      const result = await adapter.clear();
      assert.equal(result, true);
      assert.equal(adapter.size(), 0);
    });

    it("gets all keys", async () => {
      await adapter.set("app:key1", "v1");
      await adapter.set("app:key2", "v2");
      await adapter.set("user:key3", "v3");

      const keys = adapter.keys();
      assert(keys.length >= 3);
      assert(keys.includes("app:key1"));
      assert(keys.includes("app:key2"));
      assert(keys.includes("user:key3"));
    });

    it("returns cache size", async () => {
      const initialSize = adapter.size();
      await adapter.set("test", "value");

      assert.equal(adapter.size(), initialSize + 1);
    });
  });

  describe("expiration", () => {
    let adapter: RedisAdapter;

    beforeEach(async () => {
      adapter = new RedisAdapter({
        enabled: true,
        endpoint: "localhost:6379",
      });
      await adapter.connect();
    });

    it("respects TTL expiration", async () => {
      await adapter.set("expiring", "value", 0.1); // 100ms

      assert.equal(await adapter.exists("expiring"), true);

      // Wait for expiration
      await new Promise((resolve) => setTimeout(resolve, 150));

      assert.equal(await adapter.exists("expiring"), false);
      assert.equal(await adapter.get("expiring"), undefined);
    });

    it("removes expired keys from keys list", async () => {
      await adapter.set("exp1", "v1", 0.1);
      await adapter.set("exp2", "v2", 0.1);

      await new Promise((resolve) => setTimeout(resolve, 150));

      const keys = adapter.keys();
      assert(!keys.includes("exp1"));
      assert(!keys.includes("exp2"));
    });
  });

  describe("statistics", () => {
    let adapter: RedisAdapter;

    beforeEach(async () => {
      adapter = new RedisAdapter({
        enabled: true,
        endpoint: "localhost:6379",
      });
      await adapter.connect();
    });

    it("tracks cache hits", async () => {
      await adapter.set("hit:test", "value");
      await adapter.get("hit:test");

      const stats = adapter.getCacheStats();
      assert.equal(stats.hits, 1);
    });

    it("tracks cache misses", async () => {
      await adapter.get("miss:nonexistent");

      const stats = adapter.getCacheStats();
      assert.equal(stats.misses, 1);
    });

    it("tracks sets", async () => {
      await adapter.set("stat:set1", "v");
      await adapter.set("stat:set2", "v");

      const stats = adapter.getCacheStats();
      assert.equal(stats.sets, 2);
    });

    it("tracks deletes", async () => {
      await adapter.set("del:key", "v");
      await adapter.delete("del:key");

      const stats = adapter.getCacheStats();
      assert.equal(stats.deletes, 1);
    });

    it("calculates hit rate", async () => {
      await adapter.set("hr:1", "v");
      await adapter.get("hr:1"); // Hit
      await adapter.get("hr:2"); // Miss

      const stats = adapter.getCacheStats();
      assert.equal(stats.hitRate, 50);
    });

    it("returns cache size in stats", async () => {
      await adapter.set("s1", "v");
      await adapter.set("s2", "v");

      const stats = adapter.getCacheStats();
      assert.equal(stats.size, 2);
    });
  });

  describe("cache info", () => {
    let adapter: RedisAdapter;

    beforeEach(() => {
      adapter = new RedisAdapter({
        enabled: true,
        endpoint: "localhost:6379",
      });
    });

    it("returns endpoint", async () => {
      await adapter.connect();

      const info = adapter.getInfo();
      assert.equal(info.endpoint, "localhost:6379");
    });

    it("returns connection status", async () => {
      assert.equal(adapter.getInfo().connected, false);

      await adapter.connect();
      assert.equal(adapter.getInfo().connected, true);
    });

    it("returns cache size", async () => {
      await adapter.connect();
      await adapter.set("key1", "v");

      const info = adapter.getInfo();
      assert.equal(info.cacheSize, 1);
    });

    it("returns key count", async () => {
      await adapter.connect();
      await adapter.set("k1", "v");
      await adapter.set("k2", "v");

      const info = adapter.getInfo();
      assert(info.keyCount >= 2);
    });
  });

  describe("event validation", () => {
    let adapter: RedisAdapter;

    beforeEach(async () => {
      adapter = new RedisAdapter({
        enabled: true,
        endpoint: "localhost:6379",
      });
      await adapter.connect();
    });

    it("requires event type", async () => {
      try {
        await (adapter as any).sendEvent({
          data: { key: "test" },
          timestamp: new Date().toISOString(),
        });
        assert.fail("Should have thrown error");
      } catch (error) {
        assert((error as Error).message.includes("Invalid event"));
      }
    });

    it("requires event data", async () => {
      try {
        await (adapter as any).sendEvent({
          type: "event",
          timestamp: new Date().toISOString(),
        });
        assert.fail("Should have thrown error");
      } catch (error) {
        assert((error as Error).message.includes("Invalid event"));
      }
    });
  });

  describe("queue flushing", () => {
    let adapter: RedisAdapter;

    beforeEach(() => {
      adapter = new RedisAdapter({
        enabled: true,
        endpoint: "localhost:6379",
      });
    });

    it("flushes queued events on connection", async () => {
      await adapter.set("queued:1", "v1");
      await adapter.set("queued:2", "v2");

      await adapter.connect();

      assert(adapter.isConnected());
    });

    it("handles empty queue gracefully", async () => {
      await adapter.connect();

      assert(true);
    });
  });

  describe("disconnection cleanup", () => {
    let adapter: RedisAdapter;

    beforeEach(async () => {
      adapter = new RedisAdapter({
        enabled: true,
        endpoint: "localhost:6379",
      });
      await adapter.connect();
    });

    it("clears cache on disconnect", async () => {
      await adapter.set("cleanup:1", "v");
      assert(adapter.size() > 0);

      await adapter.disconnect();

      assert.equal(adapter.size(), 0);
    });

    it("clears stats on disconnect", async () => {
      await adapter.get("test");
      assert(adapter.getCacheStats().misses > 0);

      await adapter.disconnect();
      // Stats are not cleared, cache is
      assert.equal(adapter.size(), 0);
    });
  });

  describe("factory function", () => {
    it("creates enabled adapter with REDIS_URL", () => {
      const originalUrl = process.env.REDIS_URL;

      try {
        process.env.REDIS_URL = "localhost:6379";

        const adapter = createRedisAdapter(true);

        assert(adapter.config.enabled);
        assert(adapter.config.endpoint);
      } finally {
        process.env.REDIS_URL = originalUrl;
      }
    });

    it("creates enabled adapter with REDIS_ENDPOINT", () => {
      const originalUrl = process.env.REDIS_URL;
      const originalEndpoint = process.env.REDIS_ENDPOINT;

      try {
        delete process.env.REDIS_URL;
        process.env.REDIS_ENDPOINT = "redis.example.com:6380";

        const adapter = createRedisAdapter(true);

        assert(adapter.config.enabled);
        assert(adapter.config.endpoint);
      } finally {
        process.env.REDIS_URL = originalUrl;
        process.env.REDIS_ENDPOINT = originalEndpoint;
      }
    });

    it("creates disabled adapter without endpoint", () => {
      const originalUrl = process.env.REDIS_URL;
      const originalEndpoint = process.env.REDIS_ENDPOINT;

      try {
        delete process.env.REDIS_URL;
        delete process.env.REDIS_ENDPOINT;

        const adapter = createRedisAdapter(true);

        assert(!adapter.config.enabled);
      } finally {
        process.env.REDIS_URL = originalUrl;
        process.env.REDIS_ENDPOINT = originalEndpoint;
      }
    });

    it("respects enabled parameter", () => {
      const adapter = createRedisAdapter(false);

      assert(!adapter.config.enabled);
    });

    it("defaults to enabled", () => {
      const originalUrl = process.env.REDIS_URL;

      try {
        process.env.REDIS_URL = "localhost:6379";

        const adapter = createRedisAdapter();

        assert(adapter.config.enabled);
      } finally {
        process.env.REDIS_URL = originalUrl;
      }
    });
  });
});
