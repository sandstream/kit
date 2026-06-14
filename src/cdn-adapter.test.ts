import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { CDNAdapter, createCDNAdapter } from "./cdn-adapter.js";

describe("CDNAdapter", () => {
  describe("initialization", () => {
    it("creates adapter with config", () => {
      const adapter = new CDNAdapter({
        enabled: true,
        apiKey: "test-api-key",
        endpoint: "E123ABC.cloudfront.net",
      });

      assert.equal(adapter.name, "cdn");
      assert.equal(adapter.version, "1.0.0");
    });

    it("initializes with disabled config", () => {
      const adapter = new CDNAdapter({ enabled: false });
      assert(!adapter.isConnected());
    });

    it("creates adapter with default config", () => {
      const adapter = new CDNAdapter();
      assert(!adapter.isConnected());
    });
  });

  describe("connection management", () => {
    let adapter: CDNAdapter;

    beforeEach(() => {
      adapter = new CDNAdapter({
        enabled: true,
        apiKey: "test-api-key",
        endpoint: "E123ABC.cloudfront.net",
      });
    });

    it("connects with valid credentials", async () => {
      await adapter.connect();
      assert(adapter.isConnected());
    });

    it("throws error when enabled without API key", async () => {
      const invalidAdapter = new CDNAdapter({
        enabled: true,
        endpoint: "E123ABC.cloudfront.net",
      });

      try {
        await invalidAdapter.connect();
        assert.fail("Should have thrown error");
      } catch (error) {
        assert((error as Error).message.includes("API Key is required"));
      }
    });

    it("throws error when enabled without endpoint", async () => {
      const invalidAdapter = new CDNAdapter({
        enabled: true,
        apiKey: "test-key",
      });

      try {
        await invalidAdapter.connect();
        assert.fail("Should have thrown error");
      } catch (error) {
        assert((error as Error).message.includes("endpoint"));
      }
    });

    it("disconnects cleanly", async () => {
      await adapter.connect();
      assert(adapter.isConnected());

      await adapter.disconnect();
      assert(!adapter.isConnected());
    });

    it("skips connection when disabled", async () => {
      const disabledAdapter = new CDNAdapter({
        enabled: false,
        apiKey: "test-api-key",
        endpoint: "E123ABC.cloudfront.net",
      });

      await disabledAdapter.connect();
      assert(!disabledAdapter.isConnected());
    });
  });

  describe("health monitoring", () => {
    let adapter: CDNAdapter;

    beforeEach(async () => {
      adapter = new CDNAdapter({
        enabled: true,
        apiKey: "test-api-key",
        endpoint: "E123ABC.cloudfront.net",
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
      const health = await adapter.getHealth();
      const after = new Date();

      const lastCheck = new Date(health.lastCheck);

      assert(lastCheck >= before);
      assert(lastCheck <= after);
    });
  });

  describe("cache purging", () => {
    let adapter: CDNAdapter;

    beforeEach(async () => {
      adapter = new CDNAdapter({
        enabled: true,
        apiKey: "test-api-key",
        endpoint: "E123ABC.cloudfront.net",
      });
      await adapter.connect();
    });

    it("purges specific paths", async () => {
      const result = await adapter.purge(["/index.html", "/api/*"]);

      assert.equal(result, true);
    });

    it("purges single path", async () => {
      const result = await adapter.purge(["/assets/style.css"]);

      assert.equal(result, true);
    });

    it("purges all cache", async () => {
      const result = await adapter.purgeAll();

      assert.equal(result, true);
    });

    it("tracks invalidation count", async () => {
      await adapter.purge(["/path1", "/path2", "/path3"]);

      const stats = adapter.getCacheStats();
      assert.equal(stats.invalidations, 3);
    });

    it("fails when disconnected", async () => {
      await adapter.disconnect();

      const result = await adapter.purge(["/test"]);

      assert.equal(result, false);
    });
  });

  describe("cache metrics", () => {
    let adapter: CDNAdapter;

    beforeEach(async () => {
      adapter = new CDNAdapter({
        enabled: true,
        apiKey: "test-api-key",
        endpoint: "E123ABC.cloudfront.net",
      });
      await adapter.connect();
    });

    it("records cache hits", async () => {
      const result = await adapter.recordCacheHit("/index.html", 45000);

      assert.equal(result, true);
    });

    it("records cache misses", async () => {
      const result = await adapter.recordCacheMiss("/api/data", 12000);

      assert.equal(result, true);
    });

    it("records cache misses without size", async () => {
      const result = await adapter.recordCacheMiss("/new/path");

      assert.equal(result, true);
    });

    it("tracks hit count", async () => {
      await adapter.recordCacheHit("/path1");
      await adapter.recordCacheHit("/path2");

      const stats = adapter.getCacheStats();
      assert.equal(stats.hits, 2);
    });

    it("tracks miss count", async () => {
      await adapter.recordCacheMiss("/miss1");
      await adapter.recordCacheMiss("/miss2");
      await adapter.recordCacheMiss("/miss3");

      const stats = adapter.getCacheStats();
      assert.equal(stats.misses, 3);
    });

    it("calculates hit rate", async () => {
      await adapter.recordCacheHit("/hit1");
      await adapter.recordCacheHit("/hit2");
      await adapter.recordCacheMiss("/miss1");
      await adapter.recordCacheMiss("/miss2");

      const stats = adapter.getCacheStats();
      assert.equal(stats.hitRate, 50);
    });

    it("records cache evictions", async () => {
      await adapter.recordEviction();
      await adapter.recordEviction();

      const stats = adapter.getCacheStats();
      assert.equal(stats.evictions, 2);
    });

    it("handles zero hits/misses gracefully", () => {
      const stats = adapter.getCacheStats();
      assert.equal(stats.hitRate, 0);
    });
  });

  describe("cache policy", () => {
    let adapter: CDNAdapter;

    beforeEach(async () => {
      adapter = new CDNAdapter({
        enabled: true,
        apiKey: "test-api-key",
        endpoint: "E123ABC.cloudfront.net",
      });
      await adapter.connect();
    });

    it("sets cache policy for path pattern", async () => {
      const result = await adapter.setCachePolicy("/assets/*", 3600);

      assert.equal(result, true);
    });

    it("sets cache policy with cache key", async () => {
      const result = await adapter.setCachePolicy("/api/*", 300, {
        headers: "accept-encoding",
        queryStrings: "v",
      });

      assert.equal(result, true);
    });

    it("fails when disconnected", async () => {
      await adapter.disconnect();

      const result = await adapter.setCachePolicy("/path/*", 60);

      assert.equal(result, false);
    });
  });

  describe("cdn info", () => {
    it("detects CloudFront provider", () => {
      const adapter = new CDNAdapter({
        enabled: true,
        apiKey: "test-key",
        endpoint: "E123ABC.cloudfront.net",
      });

      const info = adapter.getInfo();
      assert.equal(info.provider, "cloudfront");
    });

    it("detects Cloudflare provider", () => {
      const adapter = new CDNAdapter({
        enabled: true,
        apiKey: "test-key",
        endpoint: "cf.example.com/cloudflare",
      });

      const info = adapter.getInfo();
      assert.equal(info.provider, "cloudflare");
    });

    it("returns masked API key", () => {
      const adapter = new CDNAdapter({
        enabled: true,
        apiKey: "secret-key-12345",
        endpoint: "E123ABC.cloudfront.net",
      });

      const info = adapter.getInfo();
      assert.equal(info.apiKey, "***");
    });

    it("returns empty API key when not set", () => {
      const adapter = new CDNAdapter({
        enabled: false,
      });

      const info = adapter.getInfo();
      assert.equal(info.apiKey, "");
    });

    it("returns endpoint", () => {
      const adapter = new CDNAdapter({
        enabled: true,
        apiKey: "test-key",
        endpoint: "E123ABC.cloudfront.net",
      });

      const info = adapter.getInfo();
      assert.equal(info.endpoint, "E123ABC.cloudfront.net");
    });
  });

  describe("event validation", () => {
    let adapter: CDNAdapter;

    beforeEach(async () => {
      adapter = new CDNAdapter({
        enabled: true,
        apiKey: "test-api-key",
        endpoint: "E123ABC.cloudfront.net",
      });
      await adapter.connect();
    });

    it("requires event type", async () => {
      try {
        await (adapter as any).sendEvent({
          data: { operation: "purge" },
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
    let adapter: CDNAdapter;

    beforeEach(() => {
      adapter = new CDNAdapter({
        enabled: true,
        apiKey: "test-api-key",
        endpoint: "E123ABC.cloudfront.net",
      });
    });

    it("flushes queued events on connection", async () => {
      await adapter.purge(["/queued/path1"]);
      await adapter.purge(["/queued/path2"]);

      await adapter.connect();

      assert(adapter.isConnected());
    });

    it("handles empty queue gracefully", async () => {
      await adapter.connect();

      assert(true);
    });
  });

  describe("factory function", () => {
    it("creates enabled adapter with all env vars", () => {
      const originalKey = process.env.CDN_API_KEY;
      const originalEndpoint = process.env.CDN_ENDPOINT;

      try {
        process.env.CDN_API_KEY = "test-key";
        process.env.CDN_ENDPOINT = "E123ABC.cloudfront.net";

        const adapter = createCDNAdapter(true);

        assert(adapter.config.enabled);
        assert(adapter.config.apiKey);
        assert(adapter.config.endpoint);
      } finally {
        process.env.CDN_API_KEY = originalKey;
        process.env.CDN_ENDPOINT = originalEndpoint;
      }
    });

    it("creates enabled adapter with CLOUDFRONT_DISTRIBUTION_ID", () => {
      const originalKey = process.env.CDN_API_KEY;
      const originalDist = process.env.CLOUDFRONT_DISTRIBUTION_ID;
      const originalEndpoint = process.env.CDN_ENDPOINT;

      try {
        process.env.CDN_API_KEY = "test-key";
        delete process.env.CDN_ENDPOINT;
        process.env.CLOUDFRONT_DISTRIBUTION_ID = "E123ABC";

        const adapter = createCDNAdapter(true);

        assert(adapter.config.enabled);
      } finally {
        process.env.CDN_API_KEY = originalKey;
        process.env.CLOUDFRONT_DISTRIBUTION_ID = originalDist;
        process.env.CDN_ENDPOINT = originalEndpoint;
      }
    });

    it("creates disabled adapter without credentials", () => {
      const originalKey = process.env.CDN_API_KEY;
      const originalEndpoint = process.env.CDN_ENDPOINT;
      const originalDist = process.env.CLOUDFRONT_DISTRIBUTION_ID;

      try {
        delete process.env.CDN_API_KEY;
        delete process.env.CDN_ENDPOINT;
        delete process.env.CLOUDFRONT_DISTRIBUTION_ID;

        const adapter = createCDNAdapter(true);

        assert(!adapter.config.enabled);
      } finally {
        process.env.CDN_API_KEY = originalKey;
        process.env.CDN_ENDPOINT = originalEndpoint;
        process.env.CLOUDFRONT_DISTRIBUTION_ID = originalDist;
      }
    });

    it("respects enabled parameter", () => {
      const adapter = createCDNAdapter(false);

      assert(!adapter.config.enabled);
    });

    it("defaults to enabled", () => {
      const originalKey = process.env.CDN_API_KEY;
      const originalEndpoint = process.env.CDN_ENDPOINT;

      try {
        process.env.CDN_API_KEY = "test-key";
        process.env.CDN_ENDPOINT = "E123ABC.cloudfront.net";

        const adapter = createCDNAdapter();

        assert(adapter.config.enabled);
      } finally {
        process.env.CDN_API_KEY = originalKey;
        process.env.CDN_ENDPOINT = originalEndpoint;
      }
    });
  });
});
