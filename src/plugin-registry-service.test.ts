import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  submitPlugin,
  addPluginVersion,
  releasePluginVersion,
  submitForCertification,
  certifyPlugin,
  addCertificationFinding,
  rejectCertification,
  rollbackPlugin,
  deprecateVersion,
  searchPlugins,
  getPlugin,
  getPluginVersion,
  addDependency,
  getAuditLogs,
  getRegistryMetrics,
  ratePlugin,
} from "./plugin-registry-service.js";

describe("plugin-registry-service", () => {
  const authorId = "author-123";
  const authorName = "Test Author";
  const reviewerId = "reviewer-456";
  const reviewerName = "Test Reviewer";

  describe("submitPlugin", () => {
    it("submits plugin to registry", () => {
      const { plugin, error } = submitPlugin(
        "Test Plugin",
        authorId,
        authorName,
        "A test plugin",
        "testing",
      );

      assert.ok(!error);
      assert.ok(plugin.id);
      assert.equal(plugin.status, "submitted");
      assert.equal(plugin.certification_status, "pending");
    });

    it("generates slug from plugin name", () => {
      const { plugin } = submitPlugin(
        "My Test Plugin",
        authorId,
        authorName,
        "Desc",
        "testing",
      );

      assert.equal(plugin.slug, "my-test-plugin");
    });
  });

  describe("addPluginVersion", () => {
    it("adds version to plugin", () => {
      const { plugin: submitted } = submitPlugin(
        "Plugin",
        authorId,
        authorName,
        "Desc",
        "testing",
      );

      const { pluginVersion, error } = addPluginVersion(
        submitted.id,
        "1.0.0",
        "abc123",
        1024,
        "Initial release",
      );

      assert.ok(!error);
      assert.equal(pluginVersion.version, "1.0.0");
      assert.equal(pluginVersion.status, "draft");
    });

    it("fails for nonexistent plugin", () => {
      const { error } = addPluginVersion(
        "nonexistent",
        "1.0.0",
        "hash",
        1024,
      );

      assert.ok(error);
      assert.equal(error, "Plugin not found");
    });

    it("updates current version", () => {
      const { plugin: submitted } = submitPlugin(
        "Plugin",
        authorId,
        authorName,
        "Desc",
        "testing",
      );

      addPluginVersion(submitted.id, "1.0.0", "hash1", 1024);
      addPluginVersion(submitted.id, "2.0.0", "hash2", 2048);

      const { plugin } = getPlugin(submitted.id);
      assert.equal(plugin?.current_version, "2.0.0");
    });
  });

  describe("releasePluginVersion", () => {
    it("releases plugin version", () => {
      const { plugin: submitted } = submitPlugin(
        "Plugin",
        authorId,
        authorName,
        "Desc",
        "testing",
      );
      addPluginVersion(submitted.id, "1.0.0", "hash", 1024);

      const { pluginVersion, error } = releasePluginVersion(submitted.id, "1.0.0");

      assert.ok(!error);
      assert.equal(pluginVersion?.status, "released");
    });
  });

  describe("submitForCertification", () => {
    it("submits plugin for certification", () => {
      const { plugin: submitted } = submitPlugin(
        "Plugin",
        authorId,
        authorName,
        "Desc",
        "testing",
      );

      const { plugin, error } = submitForCertification(submitted.id, "1.0.0", "gold");

      assert.ok(!error);
      assert.equal(plugin.certification_status, "reviewing");
      assert.equal(plugin.certification_tier, "gold");
    });
  });

  describe("certifyPlugin", () => {
    it("certifies plugin", () => {
      const { plugin: submitted } = submitPlugin(
        "Plugin",
        authorId,
        authorName,
        "Desc",
        "testing",
      );

      const { audit, error } = certifyPlugin(
        submitted.id,
        "1.0.0",
        "gold",
        reviewerId,
        reviewerName,
        95,
        90,
        88,
        92,
      );

      assert.ok(!error);
      assert.ok(audit.id);
      assert.equal(audit.status, "approved");
      assert.equal(audit.security_score, 95);
    });

    it("updates plugin status to certified", () => {
      const { plugin: submitted } = submitPlugin(
        "Plugin",
        authorId,
        authorName,
        "Desc",
        "testing",
      );

      certifyPlugin(submitted.id, "1.0.0", "silver", reviewerId, reviewerName, 85, 80, 82, 88);

      const { plugin } = getPlugin(submitted.id);
      assert.equal(plugin?.status, "certified");
    });
  });

  describe("addCertificationFinding", () => {
    it("adds finding to audit", () => {
      const { plugin: submitted } = submitPlugin(
        "Plugin",
        authorId,
        authorName,
        "Desc",
        "testing",
      );

      const { audit: certAudit } = certifyPlugin(
        submitted.id,
        "1.0.0",
        "bronze",
        reviewerId,
        reviewerName,
        70,
        75,
        80,
        75,
      );

      const { audit, error } = addCertificationFinding(
        certAudit.id,
        "security",
        "warning",
        "Potential XSS vulnerability",
      );

      assert.ok(!error);
      assert.equal(audit.findings.length, 1);
    });
  });

  describe("rejectCertification", () => {
    it("rejects certification", () => {
      const { plugin: submitted } = submitPlugin(
        "Plugin",
        authorId,
        authorName,
        "Desc",
        "testing",
      );
      submitForCertification(submitted.id, "1.0.0", "gold");

      const { plugin, error } = rejectCertification(
        submitted.id,
        reviewerId,
        reviewerName,
        "Code quality below threshold",
      );

      assert.ok(!error);
      assert.equal(plugin.certification_status, "rejected");
      assert.equal(plugin.status, "draft");
    });
  });

  describe("rollbackPlugin", () => {
    it("rolls back to previous version", () => {
      const { plugin: submitted } = submitPlugin(
        "Plugin",
        authorId,
        authorName,
        "Desc",
        "testing",
      );
      addPluginVersion(submitted.id, "1.0.0", "hash1", 1024);
      addPluginVersion(submitted.id, "1.1.0", "hash2", 2048);

      const { rollback, error } = rollbackPlugin(
        submitted.id,
        "1.1.0",
        "1.0.0",
        "Security issue in 1.1.0",
        reviewerId,
      );

      assert.ok(!error);
      assert.ok(rollback.id);
      assert.equal(rollback.from_version, "1.1.0");
    });

    it("updates current version on rollback", () => {
      const { plugin: submitted } = submitPlugin(
        "Plugin",
        authorId,
        authorName,
        "Desc",
        "testing",
      );
      addPluginVersion(submitted.id, "1.0.0", "hash1", 1024);
      addPluginVersion(submitted.id, "1.1.0", "hash2", 2048);

      rollbackPlugin(submitted.id, "1.1.0", "1.0.0", "Security issue", reviewerId);

      const { plugin } = getPlugin(submitted.id);
      assert.equal(plugin?.current_version, "1.0.0");
    });
  });

  describe("deprecateVersion", () => {
    it("deprecates version", () => {
      const { plugin: submitted } = submitPlugin(
        "Plugin",
        authorId,
        authorName,
        "Desc",
        "testing",
      );
      addPluginVersion(submitted.id, "1.0.0", "hash", 1024);

      const { pluginVersion, error } = deprecateVersion(submitted.id, "1.0.0");

      assert.ok(!error);
      assert.equal(pluginVersion?.status, "deprecated");
      assert.ok(pluginVersion?.deprecated_date);
    });
  });

  describe("searchPlugins", () => {
    it("searches plugins by name", () => {
      const { plugin: p1 } = submitPlugin("Database Plugin", authorId, authorName, "For databases", "data");
      const { plugin: p2 } = submitPlugin("UI Plugin", authorId, authorName, "For UIs", "ui");

      certifyPlugin(p1.id, "1.0.0", "gold", reviewerId, reviewerName, 90, 85, 88, 90);
      certifyPlugin(p2.id, "1.0.0", "gold", reviewerId, reviewerName, 90, 85, 88, 90);

      const { results } = searchPlugins({
        query: "database",
        sort_by: "rating",
        limit: 20,
        offset: 0,
      });

      assert.ok(results.some((p) => p.name.includes("Database")));
    });

    it("filters by category", () => {
      const { plugin: p1 } = submitPlugin("Plugin A", authorId, authorName, "Desc", "data");
      const { plugin: p2 } = submitPlugin("Plugin B", authorId, authorName, "Desc", "ui");

      certifyPlugin(p1.id, "1.0.0", "gold", reviewerId, reviewerName, 90, 85, 88, 90);
      certifyPlugin(p2.id, "1.0.0", "gold", reviewerId, reviewerName, 90, 85, 88, 90);

      const { results } = searchPlugins({
        category: "data",
        sort_by: "rating",
        limit: 20,
        offset: 0,
      });

      assert.ok(results.every((p) => p.category === "data"));
    });

    it("only returns certified plugins", () => {
      const { plugin } = submitPlugin("Plugin", authorId, authorName, "Desc", "testing");
      certifyPlugin(plugin.id, "1.0.0", "gold", reviewerId, reviewerName, 90, 85, 88, 90);

      const { results } = searchPlugins({
        sort_by: "rating",
        limit: 20,
        offset: 0,
      });

      assert.ok(results.some((p) => p.id === plugin.id));
    });
  });

  describe("getPlugin", () => {
    it("gets plugin by id", () => {
      const { plugin: submitted } = submitPlugin(
        "Plugin",
        authorId,
        authorName,
        "Desc",
        "testing",
      );

      const { plugin, error } = getPlugin(submitted.id);

      assert.ok(!error);
      assert.equal(plugin?.id, submitted.id);
    });

    it("fails for nonexistent plugin", () => {
      const { plugin, error } = getPlugin("nonexistent");

      assert.ok(error);
      assert.ok(!plugin);
    });
  });

  describe("getPluginVersion", () => {
    it("gets plugin version", () => {
      const { plugin: submitted } = submitPlugin(
        "Plugin",
        authorId,
        authorName,
        "Desc",
        "testing",
      );
      addPluginVersion(submitted.id, "1.0.0", "hash", 1024);

      const { pluginVersion, error } = getPluginVersion(submitted.id, "1.0.0");

      assert.ok(!error);
      assert.equal(pluginVersion?.version, "1.0.0");
    });
  });

  describe("addDependency", () => {
    it("adds dependency between plugins", () => {
      const { plugin: pluginA } = submitPlugin(
        "Plugin A",
        authorId,
        authorName,
        "Desc",
        "testing",
      );
      const { plugin: pluginB } = submitPlugin(
        "Plugin B",
        authorId,
        authorName,
        "Desc",
        "testing",
      );

      const { dependency, error } = addDependency(
        pluginA.id,
        pluginB.id,
        "^1.0.0",
        false,
      );

      assert.ok(!error);
      assert.ok(dependency.id);
      assert.equal(dependency.depends_on_name, "Plugin B");
    });
  });

  describe("getAuditLogs", () => {
    it("gets audit logs for plugin", () => {
      const { plugin } = submitPlugin("Plugin", authorId, authorName, "Desc", "testing");
      certifyPlugin(plugin.id, "1.0.0", "gold", reviewerId, reviewerName, 90, 85, 88, 90);

      const { logs } = getAuditLogs(plugin.id);

      assert.ok(logs.length > 0);
      assert.ok(logs.some((l) => l.action === "submitted"));
      assert.ok(logs.some((l) => l.action === "certified"));
    });
  });

  describe("ratePlugin", () => {
    it("rates plugin and calculates average", () => {
      const { plugin } = submitPlugin("Plugin", authorId, authorName, "Desc", "testing");
      certifyPlugin(plugin.id, "1.0.0", "gold", reviewerId, reviewerName, 90, 85, 88, 90);

      ratePlugin(plugin.id, 5);
      ratePlugin(plugin.id, 4);

      const { plugin: updated } = getPlugin(plugin.id);
      assert.equal(updated?.rating_count, 2);
      assert.ok(updated!.rating > 0);
    });

    it("fails for invalid rating", () => {
      const { plugin } = submitPlugin("Plugin", authorId, authorName, "Desc", "testing");

      const { error } = ratePlugin(plugin.id, 6);

      assert.ok(error);
      assert.equal(error, "Rating must be 1-5");
    });
  });

  describe("getRegistryMetrics", () => {
    it("returns registry metrics", () => {
      submitPlugin("Plugin 1", authorId, authorName, "Desc", "testing");
      const { plugin: p2 } = submitPlugin("Plugin 2", authorId, authorName, "Desc", "testing");
      certifyPlugin(p2.id, "1.0.0", "silver", reviewerId, reviewerName, 85, 80, 82, 88);

      const metrics = getRegistryMetrics();

      assert.ok(metrics.total_plugins >= 2);
      assert.ok(metrics.certified_plugins >= 1);
      assert.ok(metrics.average_rating >= 0);
    });
  });
});
