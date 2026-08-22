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

    it("should find plugins by description or tag", () => {
      const results = searchPlugins("payment");
      assert(results.length > 0);
      // The stripe plugin's own description says "Stripe Management API surface", so the hit comes
      // from its `payments` tag. Both are legitimate routes to a plugin, and asserting the
      // description alone encoded the old registry's invented copy ("payment processing and
      // billing adapter") rather than what the package says about itself.
      assert(
        results.some(
          (p) =>
            p.description.toLowerCase().includes("payment") ||
            p.tags.some((t) => t.includes("payment")) ||
            p.name.includes("stripe"),
        ),
      );
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
      assert(results[0].name.includes("stripe"));
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

    it("lists in a stable order, since there is no popularity to sort by", () => {
      // The old order was "downloads descending" over invented download counts. With those gone,
      // the only honest ordering is a deterministic one — the same list every run, so a diff of the
      // output means something changed.
      const first = listPlugins().map((p) => p.name);
      const second = listPlugins().map((p) => p.name);
      assert.deepEqual(first, second);
      assert.ok(first.length >= 11, `every shipped plugin must be listed: ${first.length}`);
    });

    it("should be case-insensitive for tags", () => {
      const lower = listPlugins("hosting");
      const upper = listPlugins("HOSTING");
      assert.equal(lower.length, upper.length);
    });
  });

  describe("getPluginInfo", () => {
    it("should find plugin by exact name", () => {
      const plugin = getPluginInfo("stripe");
      assert(plugin !== null);
      assert.equal(plugin?.name, "stripe");
    });

    it("should be case-insensitive", () => {
      const lower = getPluginInfo("stripe");
      const upper = getPluginInfo("STRIPE");
      assert.equal(lower?.name, upper?.name);
    });

    it("should return null for non-existent plugin", () => {
      const plugin = getPluginInfo("nonexistent/plugin");
      assert.equal(plugin, null);
    });

    it("should return complete metadata", () => {
      const plugin = getPluginInfo("stripe");
      assert(plugin);
      assert(plugin.name);
      assert(plugin.description);
      assert(plugin.version);
      assert(plugin.author);
      assert(plugin.license);
      assert(plugin.repository);
      assert(plugin.kitVersion);
      assert(Array.isArray(plugin.tags));
      assert(plugin.install);
      // NOT `published`, `rating` or `downloads`: the registry is generated from each package's own
      // manifest, and kit has no local source for any of those three. The table this replaced filled
      // them in — a made-up date, `rating: 4.8`, `downloads: 1250` — and `kit plugin list` printed
      // the stars as fact.
      assert.equal(plugin.published, undefined);
      assert.equal(plugin.rating, undefined);
    });
  });

  describe("getAllTags", () => {
    it("should return all unique tags", () => {
      const tags = getAllTags();
      assert(tags.length > 0);
      // Not "adapter": the old registry put that tag on all five entries regardless of what the
      // plugin did — half of these are read-only ingestion or management-API surfaces. Tags now
      // come from each package's own keywords, so the assertion is about tags that are true.
      assert(tags.includes("official"));
      assert(tags.includes("hosting"));
      assert(tags.includes("security"));
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
        // The id is the plugin's real id (`stripe`), not an invented provider/service pair. There
        // was no source for the second half: the entry called `stripe/payments` describes a
        // package whose own description is "Stripe Management API surface".
        assert.match(plugin.name, /^[a-z0-9-]+$/, "plugin id must match its package suffix");
        assert(plugin.description, "plugin must have description");
        assert(plugin.version, "plugin must have version");
        assert(plugin.author, "plugin must have author");
        assert(plugin.license, "plugin must have license");
        assert(plugin.repository, "plugin must have repository");
        assert(plugin.kitVersion, "plugin must have kitVersion");
        assert(Array.isArray(plugin.tags), "tags must be array");
        assert(plugin.tags.length > 0, "plugin must have at least one tag");
        // NOT a publish date: kit has no offline source for one, and the table this replaced
        // filled it in with a made-up 2026-04-15 for every entry. What must hold instead is that
        // the install command names the package the plugin is actually published as.
        assert.equal(plugin.published, undefined, "no publish date kit cannot source");
        assert(plugin.install, "plugin must have install command");
        assert.equal(
          plugin.install,
          `npm install ${plugin.package}`,
          `${plugin.name}: the printed install command must be runnable`,
        );
      }
    });

    it("lists every plugin that ships, not a subset", () => {
      // The old registry had five entries for eleven shipped packages, so `kit plugin search
      // cloudflare` answered "No plugins found" about a package published on npm. "At least 5" is
      // what let that pass; the count now follows the packages.
      assert(
        DEFAULT_REGISTRY.plugins.length >= 11,
        `expected every shipped plugin: ${DEFAULT_REGISTRY.plugins.length}`,
      );
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

    it("should have a security category", () => {
      // snyk, wiz and sentrux are read-only scan-ingestion plugins — a category the old
      // five-entry registry had no room for.
      const security = listPlugins("security");
      assert(security.length >= 3, `expected the ingestion plugins: ${security.length}`);
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
      const railwayInHosting = hosting.find((p) => p.name === "railway");
      assert(railwayInHosting);

      const railwayBySearch = searchPlugins("railway");
      assert(railwayBySearch.some((p) => p.name === "railway"));
    });
  });
});
