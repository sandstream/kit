import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  AbstractServiceAdapter,
  ServiceRegistry,
  type ServiceConfig,
  type ServiceEvent,
} from "./service-adapter.js";

// Mock adapter implementation for testing
class MockServiceAdapter extends AbstractServiceAdapter {
  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async getHealth(): Promise<{
    status: "healthy" | "degraded" | "unhealthy";
    lastCheck: string;
    responseTime: number;
    errorCount: number;
  }> {
    return {
      status: this.connected ? "healthy" : "unhealthy",
      lastCheck: new Date().toISOString(),
      responseTime: 10,
      errorCount: 0,
    };
  }

  protected async sendEvent(event: ServiceEvent): Promise<void> {
    if (!this.connected) {
      throw new Error("Not connected");
    }
    // Simulate processing
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("AbstractServiceAdapter", () => {
  describe("lifecycle management", () => {
    let adapter: MockServiceAdapter;
    const config: ServiceConfig = { enabled: true };

    beforeEach(() => {
      adapter = new MockServiceAdapter("mock", "1.0.0", config);
    });

    it("initializes adapter with name and version", () => {
      assert.equal(adapter.name, "mock");
      assert.equal(adapter.version, "1.0.0");
    });

    it("starts disconnected", () => {
      assert.equal(adapter.isConnected(), false);
    });

    it("connects to service", async () => {
      await adapter.connect();
      assert.equal(adapter.isConnected(), true);
    });

    it("disconnects from service", async () => {
      await adapter.connect();
      await adapter.disconnect();
      assert.equal(adapter.isConnected(), false);
    });

    it("initializes without errors when enabled", async () => {
      await adapter.initialize();
      assert(adapter.isConnected());
    });

    it("skips initialization when disabled", async () => {
      const disabledAdapter = new MockServiceAdapter("mock", "1.0.0", {
        enabled: false,
      });
      await disabledAdapter.initialize();
      assert(!disabledAdapter.isConnected());
    });
  });

  describe("event handling", () => {
    let adapter: MockServiceAdapter;

    beforeEach(async () => {
      adapter = new MockServiceAdapter("mock", "1.0.0", { enabled: true });
      await adapter.connect();
    });

    it("sends event when connected", async () => {
      const event: ServiceEvent = {
        type: "log",
        data: { message: "test" },
        timestamp: new Date().toISOString(),
      };

      const result = await adapter.send(event);
      assert.equal(result, true);
    });

    it("queues event when disconnected", async () => {
      await adapter.disconnect();

      const event: ServiceEvent = {
        type: "log",
        data: { message: "test" },
        timestamp: new Date().toISOString(),
      };

      const result = await adapter.send(event);
      assert.equal(result, false);

      const stats = adapter.getStats();
      assert.equal(stats.queued, 1);
    });

    it("tracks sent events", async () => {
      const event: ServiceEvent = {
        type: "log",
        data: { message: "test" },
        timestamp: new Date().toISOString(),
      };

      await adapter.send(event);
      const stats = adapter.getStats();
      assert.equal(stats.sent, 1);
    });

    it("processes batch of events", async () => {
      const events: ServiceEvent[] = [
        {
          type: "log",
          data: { message: "test1" },
          timestamp: new Date().toISOString(),
        },
        {
          type: "log",
          data: { message: "test2" },
          timestamp: new Date().toISOString(),
        },
        {
          type: "log",
          data: { message: "test3" },
          timestamp: new Date().toISOString(),
        },
      ];

      const result = await adapter.batch(events);
      assert.equal(result.sent, 3);
      assert.equal(result.failed, 0);
    });

    it("tracks failed events in batch", async () => {
      await adapter.disconnect();

      const events: ServiceEvent[] = [
        {
          type: "log",
          data: { message: "test1" },
          timestamp: new Date().toISOString(),
        },
        {
          type: "log",
          data: { message: "test2" },
          timestamp: new Date().toISOString(),
        },
      ];

      const result = await adapter.batch(events);
      assert.equal(result.sent, 0);
      assert.equal(result.failed, 2);
    });
  });

  describe("configuration management", () => {
    let adapter: MockServiceAdapter;

    beforeEach(() => {
      adapter = new MockServiceAdapter("mock", "1.0.0", {
        enabled: true,
        apiKey: "initial-key",
      });
    });

    it("stores initial config", () => {
      assert.equal(adapter.config.apiKey, "initial-key");
    });

    it("updates configuration", async () => {
      await adapter.updateConfig({ apiKey: "new-key" });
      assert.equal(adapter.config.apiKey, "new-key");
    });

    it("reconnects when updating config while connected", async () => {
      await adapter.connect();
      assert(adapter.isConnected());

      await adapter.updateConfig({ apiKey: "new-key" });
      assert(adapter.isConnected());
      assert.equal(adapter.config.apiKey, "new-key");
    });

    it("validates configuration", async () => {
      const validation = await adapter.validate();
      assert.equal(validation.valid, true);
      assert.equal(validation.errors.length, 0);
    });

    it("reports validation errors for disabled adapter without credentials", async () => {
      const disabledAdapter = new MockServiceAdapter("test", "1.0.0", {
        enabled: true,
      });

      const validation = await disabledAdapter.validate();
      assert.equal(validation.valid, false);
      assert(validation.errors.length > 0);
    });
  });

  describe("health monitoring", () => {
    let adapter: MockServiceAdapter;

    beforeEach(() => {
      adapter = new MockServiceAdapter("mock", "1.0.0", { enabled: true });
    });

    it("checks connection status", async () => {
      assert.equal(await adapter.checkConnection(), false);

      await adapter.connect();
      assert.equal(await adapter.checkConnection(), true);
    });

    it("returns health status", async () => {
      await adapter.connect();
      const health = await adapter.getHealth();

      assert.equal(health.status, "healthy");
      assert(health.lastCheck);
      assert.equal(health.responseTime, 10);
      assert.equal(health.errorCount, 0);
    });

    it("reports unhealthy status when disconnected", async () => {
      const health = await adapter.getHealth();
      assert.equal(health.status, "unhealthy");
    });
  });

  describe("statistics", () => {
    let adapter: MockServiceAdapter;

    beforeEach(async () => {
      adapter = new MockServiceAdapter("mock", "1.0.0", { enabled: true });
      await adapter.connect();
    });

    it("tracks statistics", async () => {
      const event: ServiceEvent = {
        type: "log",
        data: { message: "test" },
        timestamp: new Date().toISOString(),
      };

      await adapter.send(event);
      const stats = adapter.getStats();

      assert.equal(stats.sent, 1);
      assert.equal(stats.failed, 0);
      assert.equal(stats.queued, 0);
    });

    it("returns statistics copy", async () => {
      const stats1 = adapter.getStats();
      stats1.sent = 999;

      const stats2 = adapter.getStats();
      assert.equal(stats2.sent, 0);
    });
  });
});

describe("ServiceRegistry", () => {
  describe("adapter management", () => {
    let registry: ServiceRegistry;
    let adapter1: MockServiceAdapter;
    let adapter2: MockServiceAdapter;

    beforeEach(() => {
      registry = new ServiceRegistry();
      adapter1 = new MockServiceAdapter("service1", "1.0.0", { enabled: true });
      adapter2 = new MockServiceAdapter("service2", "2.0.0", { enabled: true });
    });

    it("registers adapters", () => {
      registry.register(adapter1);
      registry.register(adapter2);

      assert(registry.get("service1"));
      assert(registry.get("service2"));
    });

    it("retrieves adapter by name", () => {
      registry.register(adapter1);
      const retrieved = registry.get("service1");

      assert.equal(retrieved?.name, "service1");
    });

    it("returns null for unregistered adapter", () => {
      const retrieved = registry.get("nonexistent");
      assert.equal(retrieved, null);
    });

    it("gets all registered adapters", () => {
      registry.register(adapter1);
      registry.register(adapter2);

      const all = registry.getAll();
      assert.equal(all.length, 2);
    });

    it("overwrites duplicate registrations", () => {
      registry.register(adapter1);
      const adapter1New = new MockServiceAdapter("service1", "1.1.0", {
        enabled: true,
      });
      registry.register(adapter1New);

      const retrieved = registry.get("service1");
      assert.equal(retrieved?.version, "1.1.0");
    });
  });

  describe("lifecycle management", () => {
    let registry: ServiceRegistry;
    let adapter1: MockServiceAdapter;
    let adapter2: MockServiceAdapter;

    beforeEach(() => {
      registry = new ServiceRegistry();
      adapter1 = new MockServiceAdapter("service1", "1.0.0", { enabled: true });
      adapter2 = new MockServiceAdapter("service2", "2.0.0", {
        enabled: false,
      });
      registry.register(adapter1);
      registry.register(adapter2);
    });

    it("initializes all adapters", async () => {
      const result = await registry.initializeAll();

      assert.equal(result.initialized, 2); // Both adapters initialize (disabled ones just return early)
      assert.equal(result.failed, 0);
    });

    it("disconnects all adapters", async () => {
      await registry.initializeAll();
      assert(adapter1.isConnected());

      await registry.disconnectAll();
      assert(!adapter1.isConnected());
    });
  });

  describe("health status", () => {
    let registry: ServiceRegistry;
    let adapter1: MockServiceAdapter;
    let adapter2: MockServiceAdapter;

    beforeEach(async () => {
      registry = new ServiceRegistry();
      adapter1 = new MockServiceAdapter("service1", "1.0.0", { enabled: true });
      adapter2 = new MockServiceAdapter("service2", "2.0.0", { enabled: true });
      registry.register(adapter1);
      registry.register(adapter2);

      await adapter1.connect();
      await adapter2.connect();
    });

    it("gets health status of all adapters", async () => {
      const status = await registry.getHealthStatus();

      assert(status.service1);
      assert(status.service2);
      assert.equal(status.service1.status, "healthy");
      assert.equal(status.service2.status, "healthy");
    });

    it("includes health details", async () => {
      const status = await registry.getHealthStatus();

      assert(status.service1.lastCheck);
      assert.equal(status.service1.responseTime, 10);
      assert.equal(status.service1.errorCount, 0);
    });

    it("reports unhealthy adapters", async () => {
      await adapter2.disconnect();

      const status = await registry.getHealthStatus();
      assert.equal(status.service2.status, "unhealthy");
    });

    it("handles adapter errors gracefully", async () => {
      class FailingAdapter extends AbstractServiceAdapter {
        async connect(): Promise<void> {
          throw new Error("Connection failed");
        }
        async disconnect(): Promise<void> {}
        async getHealth(): Promise<{
          status: "healthy" | "degraded" | "unhealthy";
          lastCheck: string;
          responseTime: number;
          errorCount: number;
        }> {
          throw new Error("Health check failed");
        }
        protected async sendEvent(): Promise<void> {}
      }

      const failing = new FailingAdapter("failing", "1.0.0", {
        enabled: true,
        apiKey: "test",
      });
      registry.register(failing);

      const status = await registry.getHealthStatus();
      assert.equal(status.failing.status, "unhealthy");
      assert.equal(status.failing.responseTime, -1);
    });
  });

  describe("empty registry", () => {
    let registry: ServiceRegistry;

    beforeEach(() => {
      registry = new ServiceRegistry();
    });

    it("returns empty array for getAll", () => {
      const all = registry.getAll();
      assert.equal(all.length, 0);
    });

    it("initializes empty registry without error", async () => {
      const result = await registry.initializeAll();
      assert.equal(result.initialized, 0);
      assert.equal(result.failed, 0);
    });

    it("gets empty health status", async () => {
      const status = await registry.getHealthStatus();
      assert.deepEqual(status, {});
    });
  });
});
