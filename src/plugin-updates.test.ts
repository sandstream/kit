import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PluginUpdatesManager, type InstalledPlugin } from "./plugin-updates.js";

describe("PluginUpdatesManager", () => {
  describe("initialization", () => {
    it("creates manager with default directory", () => {
      const manager = new PluginUpdatesManager();
      assert(manager);
    });

    it("creates manager with custom directory", () => {
      const manager = new PluginUpdatesManager(".kit/custom");
      assert(manager);
    });
  });

  describe("API structure", () => {
    const manager = new PluginUpdatesManager();

    it("has checkForUpdates method", () => {
      assert(typeof manager.checkForUpdates === "function");
    });

    it("has getSecurityUpdates method", () => {
      assert(typeof manager.getSecurityUpdates === "function");
    });

    it("has resolveDependencies method", () => {
      assert(typeof manager.resolveDependencies === "function");
    });

    it("has getUpgradePath method", () => {
      assert(typeof manager.getUpgradePath === "function");
    });

    it("has rollback method", () => {
      assert(typeof manager.rollback === "function");
    });

    it("has updateLock method", () => {
      assert(typeof manager.updateLock === "function");
    });
  });

  describe("checkForUpdates", () => {
    const manager = new PluginUpdatesManager();

    it("accepts array of installed plugins", () => {
      const plugins: InstalledPlugin[] = [
        {
          id: "test/plugin",
          name: "Test Plugin",
          version: "1.0.0",
          installed: "2026-01-01",
          dependencies: {},
        },
      ];

      const updates = manager.checkForUpdates(plugins);
      assert(typeof updates === "object");
    });

    it("returns object with plugin IDs as keys", () => {
      const plugins: InstalledPlugin[] = [
        {
          id: "test/plugin1",
          name: "Test 1",
          version: "1.0.0",
          installed: "2026-01-01",
          dependencies: {},
        },
        {
          id: "test/plugin2",
          name: "Test 2",
          version: "1.0.0",
          installed: "2026-01-01",
          dependencies: {},
        },
      ];

      const updates = manager.checkForUpdates(plugins);
      assert(updates["test/plugin1"] !== undefined);
      assert(updates["test/plugin2"] !== undefined);
    });

    it("handles empty plugin list", () => {
      const updates = manager.checkForUpdates([]);
      assert.deepEqual(updates, {});
    });
  });

  describe("methods return correct types", () => {
    const manager = new PluginUpdatesManager();
    const testPlugin: InstalledPlugin = {
      id: "test/plugin",
      name: "Test",
      version: "1.0.0",
      installed: "2026-01-01",
      dependencies: {},
    };

    it("resolveDependencies returns object with arrays", () => {
      const result = manager.resolveDependencies("test/plugin", "1.0.0");

      assert(typeof result.resolved === "object");
      assert(Array.isArray(result.conflicts));
      assert(Array.isArray(result.unmet));
    });

    it("getUpgradePath returns array", () => {
      const path = manager.getUpgradePath("test/plugin", "1.0.0", "2.0.0");

      assert(Array.isArray(path));
    });

    it("rollback returns object with strings", () => {
      const rollback = manager.rollback("test/plugin", "1.0.0");

      assert(
        typeof rollback.previousVersion === "string" ||
          rollback.previousVersion === null,
      );
      assert(
        typeof rollback.rollbackCommand === "string" ||
          rollback.rollbackCommand === null,
      );
    });

    it("getSecurityUpdates returns array", () => {
      const securityUpdates = manager.getSecurityUpdates([testPlugin]);

      assert(Array.isArray(securityUpdates));
    });
  });

  describe("cache methods", () => {
    const manager = new PluginUpdatesManager();

    it("accepts setVersionsCache", () => {
      assert(typeof manager.setVersionsCache === "function");
      manager.setVersionsCache([]);
      assert(true);
    });

    it("accepts setInstalledCache", () => {
      assert(typeof manager.setInstalledCache === "function");
      manager.setInstalledCache([]);
      assert(true);
    });
  });
});
