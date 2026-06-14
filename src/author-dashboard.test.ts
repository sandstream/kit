import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { AuthorDashboardManager, type AuthorProfile } from "./author-dashboard.js";

describe("AuthorDashboardManager", () => {
  describe("initialization", () => {
    it("creates manager instance", () => {
      const manager = new AuthorDashboardManager();
      assert(manager);
    });

    it("initializes with empty caches", () => {
      const manager = new AuthorDashboardManager();
      assert.deepEqual(manager.getAuthorsCache(), []);
    });
  });

  describe("author management - CRUD", () => {
    let manager: AuthorDashboardManager;

    beforeEach(() => {
      manager = new AuthorDashboardManager();
    });

    it("creates new author profile", async () => {
      const author = await manager.createAuthor(
        "user@example.com",
        "John Doe",
      );

      assert(author.id);
      assert.equal(author.email, "user@example.com");
      assert.equal(author.name, "John Doe");
      assert(author.created_at);
      assert(author.updated_at);
    });

    it("creates author with optional data", async () => {
      const author = await manager.createAuthor("user@example.com", "Jane", {
        bio: "Plugin developer",
        website: "https://example.com",
      });

      assert.equal(author.bio, "Plugin developer");
      assert.equal(author.website, "https://example.com");
    });

    it("gets author profile by id", async () => {
      const created = await manager.createAuthor(
        "test@example.com",
        "Test User",
      );
      const retrieved = await manager.getAuthorProfile(created.id);

      assert(retrieved);
      assert.equal(retrieved.id, created.id);
      assert.equal(retrieved.email, "test@example.com");
    });

    it("returns null for non-existent author", async () => {
      const result = await manager.getAuthorProfile("non-existent");
      assert.equal(result, null);
    });

    it("updates author profile", async () => {
      const author = await manager.createAuthor("user@example.com", "John");
      const updated = await manager.updateAuthorProfile(author.id, {
        bio: "Updated bio",
      });

      assert(updated);
      assert.equal(updated.bio, "Updated bio");
      assert.equal(updated.email, "user@example.com");
      assert(updated.updated_at >= author.updated_at);
    });

    it("returns null when updating non-existent author", async () => {
      const result = await manager.updateAuthorProfile("non-existent", {
        bio: "test",
      });
      assert.equal(result, null);
    });
  });

  describe("author verification", () => {
    let manager: AuthorDashboardManager;

    beforeEach(() => {
      manager = new AuthorDashboardManager();
    });

    it("verifies author with github id", async () => {
      const author = await manager.createAuthor("user@example.com", "User");
      const verified = await manager.verifyAuthor(author.id, "github123");

      assert.equal(verified, true);
      const updated = await manager.getAuthorProfile(author.id);
      assert(updated?.verified_at);
      assert.equal(updated?.github_id, "github123");
    });

    it("marks author as publisher verified", async () => {
      const author = await manager.createAuthor("user@example.com", "User");
      await manager.verifyAuthor(author.id, "github123");
      const published = await manager.markPublisherVerified(author.id);

      assert.equal(published, true);
      const updated = await manager.getAuthorProfile(author.id);
      assert(updated?.verified_publisher_at);
    });

    it("cannot mark unverified author as publisher", async () => {
      const author = await manager.createAuthor("user@example.com", "User");
      const result = await manager.markPublisherVerified(author.id);
      assert.equal(result, false);
    });
  });

  describe("analytics - aggregation", () => {
    let manager: AuthorDashboardManager;

    beforeEach(() => {
      manager = new AuthorDashboardManager();
    });

    it("records plugin analytics", async () => {
      await manager.recordPluginAnalytics("plugin/test", {
        date: "2026-04-15",
        downloads: 100,
        ratings_count: 10,
        avg_rating: 4.5,
        install_success_rate: 95.5,
        update_adoption_rate: 80,
      });

      const analytics = await manager.getPluginAnalytics(
        "plugin/test",
        new Date("2026-04-10"),
        new Date("2026-04-20"),
      );

      assert.equal(analytics.length, 1);
      assert.equal(analytics[0].downloads, 100);
    });

    it("filters analytics by date range", async () => {
      await manager.recordPluginAnalytics("plugin/test", {
        date: "2026-04-15",
        downloads: 100,
        ratings_count: 10,
        avg_rating: 4.5,
        install_success_rate: 95.5,
        update_adoption_rate: 80,
      });

      await manager.recordPluginAnalytics("plugin/test", {
        date: "2026-04-20",
        downloads: 200,
        ratings_count: 20,
        avg_rating: 4.6,
        install_success_rate: 96,
        update_adoption_rate: 85,
      });

      const early = await manager.getPluginAnalytics(
        "plugin/test",
        new Date("2026-04-10"),
        new Date("2026-04-16"),
      );
      assert.equal(early.length, 1);

      const all = await manager.getPluginAnalytics(
        "plugin/test",
        new Date("2026-04-10"),
        new Date("2026-04-30"),
      );
      assert.equal(all.length, 2);
    });

    it("calculates author analytics summary", async () => {
      const author = await manager.createAuthor(
        "user@example.com",
        "Author",
      );

      await manager.recordPluginAnalytics("plugin/one", {
        date: "2026-04-15",
        downloads: 100,
        ratings_count: 10,
        avg_rating: 4.5,
        install_success_rate: 95.5,
        update_adoption_rate: 80,
      });

      const summary = await manager.getAuthorAnalytics(
        author.id,
        new Date("2026-04-10"),
        new Date("2026-04-20"),
      );

      assert(summary.total_downloads >= 0);
      assert.equal(summary.avg_rating, 4.5);
      assert.equal(summary.verified, false);
    });

    it("returns zero for non-existent author analytics", async () => {
      const summary = await manager.getAuthorAnalytics(
        "non-existent",
        new Date("2026-04-10"),
        new Date("2026-04-20"),
      );

      assert.equal(summary.total_downloads, 0);
      assert.equal(summary.verified, false);
    });

    it("calculates total downloads", async () => {
      await manager.recordPluginAnalytics("plugin/one", {
        date: "2026-04-15",
        downloads: 100,
        ratings_count: 10,
        avg_rating: 4.5,
        install_success_rate: 95.5,
        update_adoption_rate: 80,
      });

      const total = await manager.getTotalDownloads("any-author");
      assert(total > 0);
    });

    it("calculates average rating", async () => {
      await manager.recordPluginAnalytics("plugin/one", {
        date: "2026-04-15",
        downloads: 100,
        ratings_count: 10,
        avg_rating: 4.5,
        install_success_rate: 95.5,
        update_adoption_rate: 80,
      });

      const avg = await manager.getAverageRating("any-author");
      assert.equal(avg, 4.5);
    });
  });

  describe("publishing workflow", () => {
    let manager: AuthorDashboardManager;

    beforeEach(() => {
      manager = new AuthorDashboardManager();
    });

    it("starts publishing workflow", async () => {
      const author = await manager.createAuthor("user@example.com", "User");
      const workflow = await manager.startPublishing(
        author.id,
        "plugin/test",
        "1.0.0",
      );

      assert(workflow);
      assert.equal(workflow.plugin_id, "plugin/test");
      assert.equal(workflow.version, "1.0.0");
      assert.equal(workflow.status, "draft");
    });

    it("returns null when starting workflow for non-existent author", async () => {
      const workflow = await manager.startPublishing(
        "non-existent",
        "plugin/test",
        "1.0.0",
      );
      assert.equal(workflow, null);
    });

    it("retrieves publishing workflow", async () => {
      const author = await manager.createAuthor("user@example.com", "User");
      const created = await manager.startPublishing(
        author.id,
        "plugin/test",
        "1.0.0",
      );
      assert(created);

      const retrieved = await manager.getPublishingWorkflow(created.id);
      assert(retrieved);
      assert.equal(retrieved.plugin_id, "plugin/test");
    });

    it("runs validation checks", async () => {
      const author = await manager.createAuthor("user@example.com", "User");
      const workflow = await manager.startPublishing(
        author.id,
        "plugin/test",
        "1.0.0",
      );
      assert(workflow);

      const result = await manager.runValidationChecks(workflow);

      assert.equal(result.passed, true);
      assert(result.checks.length > 0);
      assert(result.checks.every((c) => c.status === "pass"));
    });

    it("publishes version after validation", async () => {
      const author = await manager.createAuthor("user@example.com", "User");
      const workflow = await manager.startPublishing(
        author.id,
        "plugin/test",
        "1.0.0",
      );
      assert(workflow);

      await manager.runValidationChecks(workflow);
      const published = await manager.publishVersion(workflow);

      assert.equal(published, true);
    });
  });

  describe("notifications", () => {
    let manager: AuthorDashboardManager;

    beforeEach(() => {
      manager = new AuthorDashboardManager();
    });

    it("adds notification", async () => {
      const author = await manager.createAuthor("user@example.com", "User");
      const notification = await manager.addNotification(
        author.id,
        "review_submitted",
        { plugin_id: "plugin/test", rating: 5 },
      );

      assert(notification.id);
      assert.equal(notification.author_id, author.id);
      assert.equal(notification.type, "review_submitted");
      assert(notification.created_at);
    });

    it("retrieves author notifications", async () => {
      const author = await manager.createAuthor("user@example.com", "User");

      await manager.addNotification(author.id, "review_submitted", {
        plugin_id: "plugin/test",
      });
      await manager.addNotification(author.id, "download_milestone", {
        milestone: 1000,
      });

      const notifications = await manager.getNotifications(author.id);
      assert.equal(notifications.length, 2);
    });

    it("marks notification as read", async () => {
      const author = await manager.createAuthor("user@example.com", "User");
      const notification = await manager.addNotification(
        author.id,
        "review_submitted",
        {},
      );

      const marked = await manager.markNotificationRead(notification.id);
      assert.equal(marked, true);

      const retrieved = await manager.getNotifications(author.id);
      assert(retrieved[0].read_at);
    });

    it("counts unread notifications", async () => {
      const author = await manager.createAuthor("user@example.com", "User");

      await manager.addNotification(author.id, "review_submitted", {});
      const n2 = await manager.addNotification(author.id, "download_milestone", {});
      await manager.markNotificationRead(n2.id);

      const unread = await manager.getUnreadCount(author.id);
      assert.equal(unread, 1);
    });

    it("returns empty notifications for non-existent author", async () => {
      const notifications = await manager.getNotifications("non-existent");
      assert.deepEqual(notifications, []);
    });
  });

  describe("cache methods", () => {
    let manager: AuthorDashboardManager;

    beforeEach(() => {
      manager = new AuthorDashboardManager();
    });

    it("sets and gets authors cache", async () => {
      const mockAuthors: AuthorProfile[] = [
        {
          id: "1",
          email: "test@example.com",
          name: "Test",
          created_at: "2026-04-15T00:00:00Z",
          updated_at: "2026-04-15T00:00:00Z",
        },
      ];

      manager.setAuthorsCache(mockAuthors);
      assert.deepEqual(manager.getAuthorsCache(), mockAuthors);
    });

    it("accepts empty cache", () => {
      manager.setAuthorsCache([]);
      assert.deepEqual(manager.getAuthorsCache(), []);
    });
  });
});
