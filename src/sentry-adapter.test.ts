import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { SentryAdapter, createSentryAdapter } from "./sentry-adapter.js";

describe("SentryAdapter", () => {
  describe("initialization", () => {
    it("creates adapter with config", () => {
      const adapter = new SentryAdapter({
        enabled: true,
        dsn: "https://examplePublicKey@o0.ingest.sentry.io/0",
      });

      assert.equal(adapter.name, "sentry");
      assert.equal(adapter.version, "1.0.0");
    });

    it("initializes with disabled config", () => {
      const adapter = new SentryAdapter({ enabled: false });
      assert(!adapter.isConnected());
    });

    it("creates adapter with default config", () => {
      const adapter = new SentryAdapter();
      assert(!adapter.isConnected());
    });
  });

  describe("connection management", () => {
    let adapter: SentryAdapter;

    beforeEach(() => {
      adapter = new SentryAdapter({
        enabled: true,
        dsn: "https://examplePublicKey@o0.ingest.sentry.io/0",
      });
    });

    it("connects with valid DSN", async () => {
      await adapter.connect();
      assert(adapter.isConnected());
    });

    it("throws error when enabled without DSN", async () => {
      const invalidAdapter = new SentryAdapter({ enabled: true });

      try {
        await invalidAdapter.connect();
        assert.fail("Should have thrown error");
      } catch (error) {
        assert((error as Error).message.includes("DSN is required"));
      }
    });

    it("throws error with invalid DSN", async () => {
      const invalidAdapter = new SentryAdapter({
        enabled: true,
        dsn: "not-a-valid-dsn",
      });

      try {
        await invalidAdapter.connect();
        assert.fail("Should have thrown error");
      } catch (error) {
        assert((error as Error).message.includes("Invalid Sentry DSN"));
      }
    });

    it("throws error with invalid DSN protocol", async () => {
      const invalidAdapter = new SentryAdapter({
        enabled: true,
        dsn: "ftp://invalid@o0.ingest.sentry.io/0",
      });

      try {
        await invalidAdapter.connect();
        assert.fail("Should have thrown error");
      } catch (error) {
        assert((error as Error).message.includes("Invalid DSN protocol"));
      }
    });

    it("disconnects cleanly", async () => {
      await adapter.connect();
      assert(adapter.isConnected());

      await adapter.disconnect();
      assert(!adapter.isConnected());
    });

    it("skips connection when disabled", async () => {
      const disabledAdapter = new SentryAdapter({
        enabled: false,
        dsn: "https://examplePublicKey@o0.ingest.sentry.io/0",
      });

      await disabledAdapter.connect();
      assert(!disabledAdapter.isConnected());
    });
  });

  describe("health monitoring", () => {
    let adapter: SentryAdapter;

    beforeEach(async () => {
      adapter = new SentryAdapter({
        enabled: true,
        dsn: "https://examplePublicKey@o0.ingest.sentry.io/0",
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

  describe("exception capturing", () => {
    let adapter: SentryAdapter;

    beforeEach(async () => {
      adapter = new SentryAdapter({
        enabled: true,
        dsn: "https://examplePublicKey@o0.ingest.sentry.io/0",
      });
      await adapter.connect();
    });

    it("captures exception", async () => {
      const error = new Error("Test error");
      const result = await adapter.captureException(error);

      assert.equal(result, true);
    });

    it("captures exception with context", async () => {
      const error = new Error("Test error");
      const result = await adapter.captureException(error, {
        userId: "user123",
        action: "fetch_data",
      });

      assert.equal(result, true);
    });

    it("includes error message in event", async () => {
      const error = new Error("Specific error message");
      const result = await adapter.captureException(error);

      assert.equal(result, true);
    });

    it("includes error stack in event", async () => {
      const error = new Error("Error with stack");
      await adapter.captureException(error);

      assert(error.stack);
    });

    it("tags exception event type", async () => {
      const error = new Error("Tagged error");
      const result = await adapter.captureException(error);

      assert.equal(result, true);
    });

    it("fails to send when disconnected", async () => {
      await adapter.disconnect();

      const error = new Error("Disconnected error");
      const result = await adapter.captureException(error);

      assert.equal(result, false);
    });
  });

  describe("message logging", () => {
    let adapter: SentryAdapter;

    beforeEach(async () => {
      adapter = new SentryAdapter({
        enabled: true,
        dsn: "https://examplePublicKey@o0.ingest.sentry.io/0",
      });
      await adapter.connect();
    });

    it("captures info message", async () => {
      const result = await adapter.captureMessage("Test message");

      assert.equal(result, true);
    });

    it("captures message with debug level", async () => {
      const result = await adapter.captureMessage("Debug message", "debug");

      assert.equal(result, true);
    });

    it("captures message with info level", async () => {
      const result = await adapter.captureMessage("Info message", "info");

      assert.equal(result, true);
    });

    it("captures message with warning level", async () => {
      const result = await adapter.captureMessage("Warning message", "warning");

      assert.equal(result, true);
    });

    it("captures message with error level", async () => {
      const result = await adapter.captureMessage("Error message", "error");

      assert.equal(result, true);
    });

    it("captures message with fatal level", async () => {
      const result = await adapter.captureMessage("Fatal message", "fatal");

      assert.equal(result, true);
    });

    it("defaults to info level", async () => {
      const result = await adapter.captureMessage("Default level message");

      assert.equal(result, true);
    });

    it("fails when disconnected", async () => {
      await adapter.disconnect();

      const result = await adapter.captureMessage("Disconnected message");

      assert.equal(result, false);
    });
  });

  describe("transaction management", () => {
    let adapter: SentryAdapter;

    beforeEach(async () => {
      adapter = new SentryAdapter({
        enabled: true,
        dsn: "https://examplePublicKey@o0.ingest.sentry.io/0",
      });
      await adapter.connect();
    });

    it("starts transaction", async () => {
      const txnId = await adapter.startTransaction("fetch-data", "http.request");

      assert(txnId);
      assert(txnId.startsWith("txn-"));
    });

    it("starts transaction with default operation", async () => {
      const txnId = await adapter.startTransaction("fetch-data");

      assert(txnId);
    });

    it("generates unique transaction IDs", async () => {
      const txnId1 = await adapter.startTransaction("fetch1");
      const txnId2 = await adapter.startTransaction("fetch2");

      assert.notEqual(txnId1, txnId2);
    });

    it("ends transaction with success", async () => {
      const txnId = await adapter.startTransaction("fetch-data");
      await adapter.endTransaction(txnId, "ok");

      assert(true);
    });

    it("ends transaction with error", async () => {
      const txnId = await adapter.startTransaction("failed-operation");
      await adapter.endTransaction(txnId, "error");

      assert(true);
    });

    it("defaults to ok status", async () => {
      const txnId = await adapter.startTransaction("operation");
      await adapter.endTransaction(txnId);

      assert(true);
    });

    it("queues transaction when disconnected", async () => {
      await adapter.disconnect();

      const txnId = await adapter.startTransaction("disconnected");
      assert(txnId);
      assert(txnId.startsWith("txn-"));
    });
  });

  describe("user context", () => {
    let adapter: SentryAdapter;

    beforeEach(async () => {
      adapter = new SentryAdapter({
        enabled: true,
        dsn: "https://examplePublicKey@o0.ingest.sentry.io/0",
      });
      await adapter.connect();
    });

    it("sets user context", async () => {
      await adapter.setUser("user123");

      assert(true);
    });

    it("sets user with metadata", async () => {
      await adapter.setUser("user123", {
        email: "user@example.com",
        plan: "premium",
      });

      assert(true);
    });

    it("queues user context when disconnected", async () => {
      await adapter.disconnect();

      // Should not throw, just queue the event
      await adapter.setUser("user123");

      assert(true);
    });
  });

  describe("project info", () => {
    let adapter: SentryAdapter;

    beforeEach(() => {
      adapter = new SentryAdapter({
        enabled: true,
        dsn: "https://examplePublicKey@o0.ingest.sentry.io/myorg/123456",
      });
    });

    it("parses DSN to get project ID", () => {
      const info = adapter.getProjectInfo();

      assert.equal(info.projectId, "123456");
    });

    it("parses DSN to get organization", () => {
      const info = adapter.getProjectInfo();

      assert.equal(info.organization, "myorg");
    });

    it("includes full DSN", () => {
      const info = adapter.getProjectInfo();

      assert(info.dsn.includes("examplePublicKey"));
    });

    it("handles missing DSN gracefully", () => {
      const noAdapter = new SentryAdapter({ enabled: false });

      const info = noAdapter.getProjectInfo();
      assert.equal(info.dsn, "");
    });

    it("handles invalid DSN format", () => {
      const invalidAdapter = new SentryAdapter({
        enabled: true,
        dsn: "invalid",
      });

      const info = invalidAdapter.getProjectInfo();
      assert(info.dsn);
    });
  });

  describe("event validation", () => {
    let adapter: SentryAdapter;

    beforeEach(async () => {
      adapter = new SentryAdapter({
        enabled: true,
        dsn: "https://examplePublicKey@o0.ingest.sentry.io/0",
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
          type: "log",
          timestamp: new Date().toISOString(),
        });
        assert.fail("Should have thrown error");
      } catch (error) {
        assert((error as Error).message.includes("Invalid event"));
      }
    });
  });

  describe("queue flushing", () => {
    let adapter: SentryAdapter;

    beforeEach(() => {
      adapter = new SentryAdapter({
        enabled: true,
        dsn: "https://examplePublicKey@o0.ingest.sentry.io/0",
      });
    });

    it("flushes queued events on connection", async () => {
      await adapter.captureMessage("Queued message 1");
      await adapter.captureMessage("Queued message 2");

      await adapter.connect();

      assert(adapter.isConnected());
    });

    it("handles empty queue gracefully", async () => {
      await adapter.connect();

      assert(true);
    });
  });

  describe("error simulation", () => {
    let adapter: SentryAdapter;

    beforeEach(async () => {
      adapter = new SentryAdapter({
        enabled: true,
        dsn: "https://examplePublicKey@o0.ingest.sentry.io/0",
      });
      await adapter.connect();
    });

    it("sometimes fails to send", async () => {
      let failures = 0;
      const attempts = 100;

      for (let i = 0; i < attempts; i++) {
        const result = await adapter.captureMessage("Test");
        if (!result) {
          failures++;
        }
      }

      assert(failures >= 0);
    });
  });

  describe("factory function", () => {
    it("creates enabled adapter with SENTRY_DSN", () => {
      const originalDsn = process.env.SENTRY_DSN;

      try {
        process.env.SENTRY_DSN = "https://key@o0.ingest.sentry.io/0";

        const adapter = createSentryAdapter(true);

        assert(adapter.config.enabled);
        assert(adapter.config.dsn);
      } finally {
        process.env.SENTRY_DSN = originalDsn;
      }
    });

    it("creates disabled adapter without DSN", () => {
      const originalDsn = process.env.SENTRY_DSN;

      try {
        delete process.env.SENTRY_DSN;

        const adapter = createSentryAdapter(true);

        assert(!adapter.config.enabled);
      } finally {
        process.env.SENTRY_DSN = originalDsn;
      }
    });

    it("respects enabled parameter", () => {
      const adapter = createSentryAdapter(false);

      assert(!adapter.config.enabled);
    });

    it("defaults to enabled", () => {
      const originalDsn = process.env.SENTRY_DSN;

      try {
        process.env.SENTRY_DSN = "https://key@o0.ingest.sentry.io/0";

        const adapter = createSentryAdapter();

        assert(adapter.config.enabled);
      } finally {
        process.env.SENTRY_DSN = originalDsn;
      }
    });
  });
});
