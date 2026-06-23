import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  searchPlugins,
  listPlugins,
  getPluginInfo,
  getAllTags,
  formatPluginForDisplay,
  DEFAULT_REGISTRY,
  type PluginMetadata,
} from "./plugins.js";

describe("Plugin Registry", () => {
  describe("searchPlugins", () => {
    it("should find plugins by name", () => {
      const results = searchPlugins("stripe");
      assert(results.length > 0);
      assert(results[0].name.includes("stripe"));
    });

    it("should find plugins by description", () => {
      const results = searchPlugins("payment");
      assert(results.length > 0);
      assert(results.some((p) => p.description.toLowerCase().includes("payment")));
    });

    it("should find plugins by tag", () => {
      const results = searchPlugins("database");
      assert(results.length > 0);
      assert(results.some((p) => p.tags.includes("database")));
    });

    it("should return empty array for no matches", () => {
      const results = searchPlugins("nonexistentplugin12345");
      assert.deepEqual(results, []);
    });

    it("should rank results by relevance", () => {
      const results = searchPlugins("stripe");
      // Exact name match should come first
      assert(results[0].name === "stripe/payments" || results[0].name.includes("stripe"));
    });

    it("should be case-insensitive", () => {
      const lower = searchPlugins("stripe");
      const upper = searchPlugins("STRIPE");
      assert.equal(lower.length, upper.length);
      assert.equal(lower[0].name, upper[0].name);
    });
  });

  describe("listPlugins", () => {
    it("should return all plugins when no filter", () => {
      const all = listPlugins();
      assert(all.length > 0);
      assert.equal(all.length, DEFAULT_REGISTRY.plugins.length);
    });

    it("should filter by tag", () => {
      const hosting = listPlugins("hosting");
      assert(hosting.length > 0);
      assert(hosting.every((p) => p.tags.includes("hosting")));
    });

    it("should return empty for non-existent tag", () => {
      const results = listPlugins("nonexistenttag");
      assert.equal(results.length, 0);
    });

    it("should sort by download count", () => {
      const sorted = listPlugins();
      for (let i = 0; i < sorted.length - 1; i++) {
        const current = sorted[i].downloads ?? 0;
        const next = sorted[i + 1].downloads ?? 0;
        assert(current >= next, "should be sorted by downloads descending");
      }
    });

    it("should be case-insensitive for tags", () => {
      const lower = listPlugins("hosting");
      const upper = listPlugins("HOSTING");
      assert.equal(lower.length, upper.length);
    });
  });

  describe("getPluginInfo", () => {
    it("should find plugin by exact name", () => {
      const plugin = getPluginInfo("stripe/payments");
      assert(plugin !== null);
      assert.equal(plugin?.name, "stripe/payments");
    });

    it("should be case-insensitive", () => {
      const lower = getPluginInfo("stripe/payments");
      const upper = getPluginInfo("STRIPE/PAYMENTS");
      assert.equal(lower?.name, upper?.name);
    });

    it("should return null for non-existent plugin", () => {
      const plugin = getPluginInfo("nonexistent/plugin");
      assert.equal(plugin, null);
    });

    it("should return complete metadata", () => {
      const plugin = getPluginInfo("stripe/payments");
      assert(plugin);
      assert(plugin.name);
      assert(plugin.description);
      assert(plugin.version);
      assert(plugin.author);
      assert(plugin.license);
      assert(plugin.repository);
      assert(plugin.kitVersion);
      assert(Array.isArray(plugin.tags));
      assert(plugin.published);
      assert(plugin.install);
    });
  });

  describe("getAllTags", () => {
    it("should return all unique tags", () => {
      const tags = getAllTags();
      assert(tags.length > 0);
      assert(tags.includes("adapter"));
      assert(tags.includes("official"));
    });

    it("should return sorted tags", () => {
      const tags = getAllTags();
      const sorted = [...tags].sort();
      assert.deepEqual(tags, sorted);
    });

    it("should have no duplicates", () => {
      const tags = getAllTags();
      const unique = new Set(tags);
      assert.equal(tags.length, unique.size);
    });

    it("should contain common category tags", () => {
      const tags = getAllTags();
      const hasCommonTags =
        tags.includes("adapter") ||
        tags.includes("hosting") ||
        tags.includes("database") ||
        tags.includes("payments");
      assert(hasCommonTags);
    });
  });

  describe("formatPluginForDisplay", () => {
    const testPlugin: PluginMetadata = {
      name: "test/plugin",
      description: "Test plugin for display formatting",
      version: "1.0.0",
      author: "Test Author",
      license: "MIT",
      repository: "https://github.com/test/plugin",
      kitVersion: ">=0.1.0",
      tags: ["test", "example"],
      published: "2026-04-15T00:00:00Z",
      downloads: 100,
      rating: 4.5,
      install: "npm install @test/plugin",
    };

    it("should format basic plugin display", () => {
      const display = formatPluginForDisplay(testPlugin);
      assert(display.includes("test/plugin"));
      assert(display.includes("Test plugin for display formatting"));
      assert(display.includes("1.0.0"));
    });

    it("should include rating in basic display", () => {
      const display = formatPluginForDisplay(testPlugin);
      assert(display.includes("4.5"));
    });

    it("should include detailed info when requested", () => {
      const display = formatPluginForDisplay(testPlugin, true);
      assert(display.includes("Test Author"));
      assert(display.includes("MIT"));
      assert(display.includes("test, example"));
      assert(display.includes("100"));
      assert(display.includes("npm install @test/plugin"));
    });

    it("should handle missing rating gracefully", () => {
      const noRating = { ...testPlugin, rating: undefined };
      const display = formatPluginForDisplay(noRating);
      assert(display.includes("test/plugin"));
    });

    it("should handle missing downloads gracefully", () => {
      const noDownloads = { ...testPlugin, downloads: undefined };
      const display = formatPluginForDisplay(noDownloads, true);
      assert(display.includes("test/plugin"));
      assert(!display.includes("Downloads:"));
    });
  });

  describe("Plugin Registry Data", () => {
    it("should have valid plugin metadata", () => {
      for (const plugin of DEFAULT_REGISTRY.plugins) {
        assert(plugin.name, "plugin must have name");
        assert(plugin.name.includes("/"), "plugin name must be provider/service");
        assert(plugin.description, "plugin must have description");
        assert(plugin.version, "plugin must have version");
        assert(plugin.author, "plugin must have author");
        assert(plugin.license, "plugin must have license");
        assert(plugin.repository, "plugin must have repository");
        assert(plugin.kitVersion, "plugin must have kitVersion");
        assert(Array.isArray(plugin.tags), "tags must be array");
        assert(plugin.tags.length > 0, "plugin must have at least one tag");
        assert(plugin.published, "plugin must have published date");
        assert(plugin.install, "plugin must have install command");
      }
    });

    it("should have at least 5 plugins", () => {
      assert(DEFAULT_REGISTRY.plugins.length >= 5, "registry should have at least 5 plugins");
    });

    it("should have 'official' tag for all built-in plugins", () => {
      for (const plugin of DEFAULT_REGISTRY.plugins) {
        assert(plugin.tags.includes("official"), `${plugin.name} should have 'official' tag`);
      }
    });

    it("should have unique plugin names", () => {
      const names = DEFAULT_REGISTRY.plugins.map((p) => p.name);
      const unique = new Set(names);
      assert.equal(names.length, unique.size, "all plugin names should be unique");
    });
  });

  describe("Plugin Categories", () => {
    it("should have hosting category", () => {
      const hosting = listPlugins("hosting");
      assert(hosting.length > 0);
    });

    it("should have database category", () => {
      const database = listPlugins("database");
      assert(database.length > 0);
    });

    it("should have payments category", () => {
      const payments = listPlugins("payments");
      assert(payments.length > 0);
    });

    it("should have adapter tag", () => {
      const adapters = listPlugins("adapter");
      assert(adapters.length > 0);
    });
  });

  describe("Integration Tests", () => {
    it("should find plugin by search and get full info", () => {
      const results = searchPlugins("stripe");
      assert(results.length > 0);
      const info = getPluginInfo(results[0].name);
      assert(info);
      assert.equal(info.name, results[0].name);
    });

    it("should support case-insensitive workflows", () => {
      const lower = searchPlugins("vercel");
      const upper = searchPlugins("VERCEL");
      assert.equal(lower.length, upper.length);
      if (lower.length > 0) {
        assert.equal(lower[0].name, upper[0].name);
      }
    });

    it("should allow filtering by category then searching", () => {
      const hosting = listPlugins("hosting");
      const railwayInHosting = hosting.find((p) => p.name === "railway/hosting");
      assert(railwayInHosting);

      const railwayBySearch = searchPlugins("railway");
      assert(railwayBySearch.some((p) => p.name === "railway/hosting"));
    });
  });
});
