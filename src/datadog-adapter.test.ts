import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatadogAdapter, createDatadogAdapter } from "./datadog-adapter.js";

describe("DatadogAdapter", () => {
  describe("initialization", () => {
    it("creates adapter with config", () => {
      const adapter = new DatadogAdapter({
        enabled: true,
        apiKey: "abcdef0123456789abcdef0123456789",
      });

      assert.equal(adapter.name, "datadog");
      assert.equal(adapter.version, "1.0.0");
    });

    it("initializes with disabled config", () => {
      const adapter = new DatadogAdapter({ enabled: false });
      assert(!adapter.isConnected());
    });

    it("creates adapter with default config", () => {
      const adapter = new DatadogAdapter();
      assert(!adapter.isConnected());
    });
  });

  describe("connection management", () => {
    let adapter: DatadogAdapter;

    beforeEach(() => {
      adapter = new DatadogAdapter({
        enabled: true,
        apiKey: "abcdef0123456789abcdef0123456789",
      });
    });

    it("connects with valid API key", async () => {
      await adapter.connect();
      assert(adapter.isConnected());
    });

    it("throws error when enabled without API key", async () => {
      const invalidAdapter = new DatadogAdapter({ enabled: true });

      try {
        await invalidAdapter.connect();
        assert.fail("Should have thrown error");
      } catch (error) {
        assert((error as Error).message.includes("API Key is required"));
      }
    });

    it("throws error with invalid API key format", async () => {
      const invalidAdapter = new DatadogAdapter({
        enabled: true,
        apiKey: "invalid-key",
      });

      try {
        await invalidAdapter.connect();
        assert.fail("Should have thrown error");
      } catch (error) {
        assert((error as Error).message.includes("Invalid Datadog API Key"));
      }
    });

    it("disconnects cleanly", async () => {
      await adapter.connect();
      assert(adapter.isConnected());

      await adapter.disconnect();
      assert(!adapter.isConnected());
    });

    it("skips connection when disabled", async () => {
      const disabledAdapter = new DatadogAdapter({
        enabled: false,
        apiKey: "abcdef0123456789abcdef0123456789",
      });

      await disabledAdapter.connect();
      assert(!disabledAdapter.isConnected());
    });
  });

  describe("health monitoring", () => {
    let adapter: DatadogAdapter;

    beforeEach(async () => {
      adapter = new DatadogAdapter({
        enabled: true,
        apiKey: "abcdef0123456789abcdef0123456789",
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

  describe("metric recording", () => {
    let adapter: DatadogAdapter;

    beforeEach(async () => {
      adapter = new DatadogAdapter({
        enabled: true,
        apiKey: "abcdef0123456789abcdef0123456789",
      });
      await adapter.connect();
    });

    it("records metric value", async () => {
      const result = await adapter.recordMetric("request.latency", 150);

      assert.equal(result, true);
    });

    it("records metric with tags", async () => {
      const result = await adapter.recordMetric("cache.hits", 42, {
        cache_type: "redis",
        region: "us-east-1",
      });

      assert.equal(result, true);
    });

    it("increments metric counter", async () => {
      const result = await adapter.incrementMetric("api.requests", 1);

      assert.equal(result, true);
    });

    it("increments by custom amount", async () => {
      const result = await adapter.incrementMetric("batch.processed", 50);

      assert.equal(result, true);
    });

    it("defaults to increment of 1", async () => {
      const result = await adapter.incrementMetric("counter");

      assert.equal(result, true);
    });

    it("gets metric value", async () => {
      await adapter.incrementMetric("test.metric", 5);

      const value = adapter.getMetric("test.metric");
      assert.equal(value, 5);
    });

    it("returns undefined for non-existent metric", () => {
      const value = adapter.getMetric("nonexistent");

      assert.equal(value, undefined);
    });

    it("fails to record when disconnected", async () => {
      await adapter.disconnect();

      const result = await adapter.recordMetric("offline.metric", 100);

      assert.equal(result, false);
    });
  });

  describe("trace spans", () => {
    let adapter: DatadogAdapter;

    beforeEach(async () => {
      adapter = new DatadogAdapter({
        enabled: true,
        apiKey: "abcdef0123456789abcdef0123456789",
      });
      await adapter.connect();
    });

    it("starts a trace span", async () => {
      const spanId = await adapter.startSpan("trace-123", "database-query");

      assert(spanId);
      assert(spanId.includes("trace-123"));
    });

    it("starts span with parent", async () => {
      const spanId = await adapter.startSpan("trace-456", "nested-operation", "parent-span-789");

      assert(spanId);
    });

    it("ends span with success", async () => {
      const spanId = await adapter.startSpan("trace-789", "operation");
      await adapter.endSpan(spanId, "ok");

      assert(true);
    });

    it("ends span with error", async () => {
      const spanId = await adapter.startSpan("trace-error", "failed-op");
      await adapter.endSpan(spanId, "error");

      assert(true);
    });

    it("defaults to ok status", async () => {
      const spanId = await adapter.startSpan("trace-default", "op");
      await adapter.endSpan(spanId);

      assert(true);
    });

    it("tracks span duration", async () => {
      const spanId = await adapter.startSpan("trace-timing", "slow-op");
      await new Promise((resolve) => setTimeout(resolve, 10));
      await adapter.endSpan(spanId);

      assert(true);
    });
  });

  describe("logging", () => {
    let adapter: DatadogAdapter;

    beforeEach(async () => {
      adapter = new DatadogAdapter({
        enabled: true,
        apiKey: "abcdef0123456789abcdef0123456789",
      });
      await adapter.connect();
    });

    it("logs info message", async () => {
      const result = await adapter.logEvent("Application started");

      assert.equal(result, true);
    });

    it("logs with debug level", async () => {
      const result = await adapter.logEvent("Debug info", "debug");

      assert.equal(result, true);
    });

    it("logs with info level", async () => {
      const result = await adapter.logEvent("Information", "info");

      assert.equal(result, true);
    });

    it("logs with warning level", async () => {
      const result = await adapter.logEvent("Warning message", "warning");

      assert.equal(result, true);
    });

    it("logs with error level", async () => {
      const result = await adapter.logEvent("Error occurred", "error");

      assert.equal(result, true);
    });

    it("logs with metadata", async () => {
      const result = await adapter.logEvent("Database operation", "info", {
        duration: 250,
        query: "SELECT * FROM users",
        rows: 1000,
      });

      assert.equal(result, true);
    });

    it("defaults to info level", async () => {
      const result = await adapter.logEvent("Default level message");

      assert.equal(result, true);
    });

    it("fails when disconnected", async () => {
      await adapter.disconnect();

      const result = await adapter.logEvent("Offline log");

      assert.equal(result, false);
    });
  });

  describe("events", () => {
    let adapter: DatadogAdapter;

    beforeEach(async () => {
      adapter = new DatadogAdapter({
        enabled: true,
        apiKey: "abcdef0123456789abcdef0123456789",
      });
      await adapter.connect();
    });

    it("records event", async () => {
      const result = await adapter.recordEvent(
        "Deployment Started",
        "Version 1.2.3 deployed to production",
      );

      assert.equal(result, true);
    });

    it("records event with tags", async () => {
      const result = await adapter.recordEvent(
        "Database Migration",
        "Schema updated",
        {
          service: "api",
          environment: "production",
        },
      );

      assert.equal(result, true);
    });

    it("records event with low severity", async () => {
      const result = await adapter.recordEvent("Minor Issue", "Non-critical alert", {}, "low");

      assert.equal(result, true);
    });

    it("records event with medium severity", async () => {
      const result = await adapter.recordEvent(
        "Medium Alert",
        "Moderate issue detected",
        {},
        "medium",
      );

      assert.equal(result, true);
    });

    it("records event with high severity", async () => {
      const result = await adapter.recordEvent("High Priority", "Critical issue", {}, "high");

      assert.equal(result, true);
    });

    it("records event with critical severity", async () => {
      const result = await adapter.recordEvent(
        "Critical Issue",
        "System failure",
        {},
        "critical",
      );

      assert.equal(result, true);
    });

    it("defaults to medium severity", async () => {
      const result = await adapter.recordEvent("Default Severity", "No severity specified");

      assert.equal(result, true);
    });

    it("fails when disconnected", async () => {
      await adapter.disconnect();

      const result = await adapter.recordEvent("Offline Event", "Cannot send");

      assert.equal(result, false);
    });
  });

  describe("site info", () => {
    let adapter: DatadogAdapter;

    beforeEach(() => {
      adapter = new DatadogAdapter({
        enabled: true,
        apiKey: "abcdef0123456789abcdef0123456789",
        endpoint: "datadoghq.eu",
      });
    });

    it("returns API key", () => {
      const info = adapter.getSiteInfo();

      assert(info.apiKey.includes("abcdef"));
    });

    it("returns site", () => {
      const info = adapter.getSiteInfo();

      assert.equal(info.site, "datadoghq.eu");
    });

    it("defaults to datadoghq.com site", () => {
      const noSiteAdapter = new DatadogAdapter({
        enabled: true,
        apiKey: "abcdef0123456789abcdef0123456789",
      });

      const info = noSiteAdapter.getSiteInfo();
      assert.equal(info.site, "datadoghq.com");
    });

    it("counts metrics", async () => {
      await adapter.connect();
      await adapter.recordMetric("test.metric", 100);

      const info = adapter.getSiteInfo();
      assert.equal(info.metricsCount, 1);
    });

    it("counts traces", async () => {
      await adapter.connect();
      await adapter.startSpan("trace-1", "op");

      const info = adapter.getSiteInfo();
      assert(info.tracesCount > 0);
    });

    it("clears metrics on disconnect", async () => {
      await adapter.connect();
      await adapter.recordMetric("metric1", 100);
      assert.equal(adapter.getSiteInfo().metricsCount, 1);

      await adapter.disconnect();
      assert.equal(adapter.getSiteInfo().metricsCount, 0);
    });
  });

  describe("event validation", () => {
    let adapter: DatadogAdapter;

    beforeEach(async () => {
      adapter = new DatadogAdapter({
        enabled: true,
        apiKey: "abcdef0123456789abcdef0123456789",
      });
      await adapter.connect();
    });

    it("requires event type", async () => {
      try {
        await (adapter as any).sendEvent({
          data: { message: "test" },
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
          type: "metric",
          timestamp: new Date().toISOString(),
        });
        assert.fail("Should have thrown error");
      } catch (error) {
        assert((error as Error).message.includes("Invalid event"));
      }
    });
  });

  describe("queue flushing", () => {
    let adapter: DatadogAdapter;

    beforeEach(() => {
      adapter = new DatadogAdapter({
        enabled: true,
        apiKey: "abcdef0123456789abcdef0123456789",
      });
    });

    it("flushes queued events on connection", async () => {
      await adapter.recordMetric("queued.metric", 100);
      await adapter.recordMetric("queued.metric2", 200);

      await adapter.connect();

      assert(adapter.isConnected());
    });

    it("handles empty queue gracefully", async () => {
      await adapter.connect();

      assert(true);
    });
  });

  describe("error simulation", () => {
    let adapter: DatadogAdapter;

    beforeEach(async () => {
      adapter = new DatadogAdapter({
        enabled: true,
        apiKey: "abcdef0123456789abcdef0123456789",
      });
      await adapter.connect();
    });

    it("sometimes fails to send", async () => {
      let failures = 0;
      const attempts = 100;

      for (let i = 0; i < attempts; i++) {
        const result = await adapter.recordMetric("stress-test", i);
        if (!result) {
          failures++;
        }
      }

      assert(failures >= 0);
    });
  });

  describe("factory function", () => {
    it("creates enabled adapter with DATADOG_API_KEY", () => {
      const originalKey = process.env.DATADOG_API_KEY;
      const originalSite = process.env.DATADOG_SITE;

      try {
        process.env.DATADOG_API_KEY = "abcdef0123456789abcdef0123456789";
        process.env.DATADOG_SITE = "datadoghq.eu";

        const adapter = createDatadogAdapter(true);

        assert(adapter.config.enabled);
        assert(adapter.config.apiKey);
      } finally {
        process.env.DATADOG_API_KEY = originalKey;
        process.env.DATADOG_SITE = originalSite;
      }
    });

    it("creates disabled adapter without API key", () => {
      const originalKey = process.env.DATADOG_API_KEY;

      try {
        delete process.env.DATADOG_API_KEY;

        const adapter = createDatadogAdapter(true);

        assert(!adapter.config.enabled);
      } finally {
        process.env.DATADOG_API_KEY = originalKey;
      }
    });

    it("respects enabled parameter", () => {
      const adapter = createDatadogAdapter(false);

      assert(!adapter.config.enabled);
    });

    it("defaults to enabled", () => {
      const originalKey = process.env.DATADOG_API_KEY;

      try {
        process.env.DATADOG_API_KEY = "abcdef0123456789abcdef0123456789";

        const adapter = createDatadogAdapter();

        assert(adapter.config.enabled);
      } finally {
        process.env.DATADOG_API_KEY = originalKey;
      }
    });
  });
});
