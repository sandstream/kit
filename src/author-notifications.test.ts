import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { AuthorNotificationEngine } from "./author-notifications.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("AuthorNotificationEngine", () => {
  describe("initialization", () => {
    it("creates engine instance", () => {
      const engine = new AuthorNotificationEngine();
      assert(engine);
    });

    it("starts with empty caches", () => {
      const engine = new AuthorNotificationEngine();
      assert.equal(engine.getNotificationsCache().size, 0);
      assert.equal(engine.getPreferencesCache().size, 0);
      assert.equal(engine.getDigestSettingsCache().size, 0);
    });
  });

  describe("createNotification", () => {
    let engine: AuthorNotificationEngine;

    beforeEach(() => {
      engine = new AuthorNotificationEngine();
    });

    it("creates a notification", () => {
      const notif = engine.createNotification(
        "author-1",
        "new_review",
        "New review",
        "User left a 5-star review",
      );
      assert(notif.id);
      assert.equal(notif.authorId, "author-1");
      assert.equal(notif.type, "new_review");
      assert.equal(notif.read, false);
    });

    it("includes plugin ID when provided", () => {
      const notif = engine.createNotification(
        "author-1",
        "new_review",
        "New review",
        "Review message",
        {},
        "plugin-stripe",
      );
      assert.equal(notif.pluginId, "plugin-stripe");
    });

    it("stores metadata", () => {
      const metadata = { reviewerId: "user-123", rating: 5 };
      const notif = engine.createNotification(
        "author-1",
        "new_review",
        "New review",
        "Message",
        metadata,
      );
      assert.deepEqual(notif.metadata, metadata);
    });

    it("assigns channels based on notification type", () => {
      const critical = engine.createNotification(
        "author-1",
        "security_alert",
        "Security",
        "Alert",
      );
      assert(critical.channels.includes("in_app"));
      assert(critical.channels.includes("email"));

      const nonCritical = engine.createNotification("author-1", "new_review", "Review", "Message");
      assert(nonCritical.channels.length > 0);
    });

    it("retrieves notification by ID", () => {
      const created = engine.createNotification("author-1", "new_review", "Title", "Message");
      const found = engine.getNotification(created.id);
      assert.equal(found?.id, created.id);
    });

    it("returns null for unknown notification", () => {
      const notif = engine.getNotification("unknown");
      assert.equal(notif, null);
    });
  });

  describe("getAuthorNotifications", () => {
    let engine: AuthorNotificationEngine;

    beforeEach(() => {
      engine = new AuthorNotificationEngine();
      engine.createNotification("author-1", "new_review", "Review 1", "Message 1");
      engine.createNotification("author-1", "new_review", "Review 2", "Message 2");
      engine.createNotification("author-2", "new_review", "Review 3", "Message 3");
    });

    it("returns all notifications for an author", () => {
      const notifs = engine.getAuthorNotifications("author-1");
      assert.equal(notifs.length, 2);
      assert(notifs.every((n) => n.authorId === "author-1"));
    });

    it("filters unread notifications", () => {
      const allNotifs = engine.getAuthorNotifications("author-1");
      const unread = engine.getAuthorNotifications("author-1", true);
      assert.equal(allNotifs.length, 2);
      assert.equal(unread.length, 2);

      // Mark one as read
      engine.markAsRead(allNotifs[0].id);
      const stillUnread = engine.getAuthorNotifications("author-1", true);
      assert.equal(stillUnread.length, 1);
    });

    it("sorts by creation date (newest first)", () => {
      const notifs = engine.getAuthorNotifications("author-1");
      for (let i = 1; i < notifs.length; i++) {
        assert(
          new Date(notifs[i - 1].createdAt) >= new Date(notifs[i].createdAt),
        );
      }
    });

    it("respects limit parameter", () => {
      for (let i = 0; i < 30; i++) {
        engine.createNotification("author-1", "new_review", `Review ${i}`, "Message");
      }
      const notifs = engine.getAuthorNotifications("author-1", false, 10);
      assert(notifs.length <= 10);
    });

    it("returns empty for unknown author", () => {
      const notifs = engine.getAuthorNotifications("unknown");
      assert.equal(notifs.length, 0);
    });
  });

  describe("markAsRead", () => {
    let engine: AuthorNotificationEngine;

    beforeEach(() => {
      engine = new AuthorNotificationEngine();
    });

    it("marks notification as read", () => {
      const notif = engine.createNotification("author-1", "new_review", "Title", "Message");
      assert(!notif.read);

      const marked = engine.markAsRead(notif.id);
      assert(marked?.read);
      assert(marked?.readAt);
    });

    it("returns null for unknown notification", () => {
      const result = engine.markAsRead("unknown");
      assert.equal(result, null);
    });

    it("markMultipleAsRead marks all unread", () => {
      engine.createNotification("author-1", "new_review", "1", "Message 1");
      engine.createNotification("author-1", "new_review", "2", "Message 2");
      engine.createNotification("author-1", "new_review", "3", "Message 3");

      const count = engine.markMultipleAsRead("author-1");
      assert.equal(count, 3);

      const remaining = engine.getAuthorNotifications("author-1", true);
      assert.equal(remaining.length, 0);
    });
  });

  describe("deleteNotification", () => {
    let engine: AuthorNotificationEngine;

    beforeEach(() => {
      engine = new AuthorNotificationEngine();
    });

    it("deletes a notification", () => {
      const notif = engine.createNotification("author-1", "new_review", "Title", "Message");
      const deleted = engine.deleteNotification(notif.id);
      assert(deleted);
      assert.equal(engine.getNotification(notif.id), null);
    });

    it("returns false for unknown notification", () => {
      const deleted = engine.deleteNotification("unknown");
      assert(!deleted);
    });
  });

  describe("notification preferences", () => {
    let engine: AuthorNotificationEngine;

    beforeEach(() => {
      engine = new AuthorNotificationEngine();
    });

    it("sets notification preference", () => {
      const pref = engine.setPreference("author-1", "new_review", ["in_app", "email"], true);
      assert.equal(pref.authorId, "author-1");
      assert.equal(pref.notificationType, "new_review");
      assert(pref.enabled);
    });

    it("disables notification type", () => {
      engine.disableNotificationType("author-1", "new_review");
      const pref = engine.getPreference("author-1", "new_review");
      assert(!pref?.enabled);
    });

    it("enables notification type", () => {
      engine.enableNotificationType("author-1", "new_review", ["in_app"]);
      const pref = engine.getPreference("author-1", "new_review");
      assert(pref?.enabled);
    });

    it("gets author preferences", () => {
      engine.setPreference("author-1", "new_review", ["in_app"], true);
      engine.setPreference("author-1", "security_alert", ["email"], true);
      const prefs = engine.getAuthorPreferences("author-1");
      assert(prefs.length >= 2);
    });

    it("returns null for unknown preference", () => {
      const pref = engine.getPreference("author-1", "new_review");
      assert.equal(pref, null);
    });
  });

  describe("digest settings", () => {
    let engine: AuthorNotificationEngine;

    beforeEach(() => {
      engine = new AuthorNotificationEngine();
    });

    it("sets digest settings", () => {
      const settings = engine.setDigestSettings(
        "author-1",
        "daily",
        ["new_review", "download_milestone"],
        undefined,
        "09:00",
      );
      assert.equal(settings.frequency, "daily");
      assert.equal(settings.preferredTime, "09:00");
    });

    it("includes preferred day for weekly digest", () => {
      const settings = engine.setDigestSettings(
        "author-1",
        "weekly",
        ["new_review"],
        1, // Monday
      );
      assert.equal(settings.preferredDay, 1);
    });

    it("retrieves digest settings", () => {
      engine.setDigestSettings("author-1", "daily", ["new_review"]);
      const found = engine.getDigestSettings("author-1");
      assert.equal(found?.frequency, "daily");
    });

    it("returns null for unknown digest settings", () => {
      const settings = engine.getDigestSettings("unknown");
      assert.equal(settings, null);
    });
  });

  describe("compileDigest", () => {
    let engine: AuthorNotificationEngine;

    beforeEach(() => {
      engine = new AuthorNotificationEngine();
      engine.setDigestSettings(
        "author-1",
        "daily",
        ["new_review", "download_milestone"],
      );
    });

    it("compiles digest from queued entries", () => {
      engine.createNotification("author-1", "new_review", "Review 1", "Message 1");
      engine.createNotification("author-1", "download_milestone", "Milestone", "100 downloads!");
      engine.createNotification("author-1", "security_alert", "Alert", "Alert"); // Not in includeTypes

      const digest = engine.compileDigest("author-1", "daily");
      assert(digest);
      assert.equal(digest.totalCount, 2); // Only new_review and download_milestone
    });

    it("returns null if no pending entries", () => {
      const digest = engine.compileDigest("author-1", "daily");
      assert.equal(digest, null);
    });

    it("returns null if frequency mismatch", () => {
      engine.createNotification("author-1", "new_review", "Review", "Message");
      const digest = engine.compileDigest("author-1", "weekly"); // Settings are daily
      assert.equal(digest, null);
    });

    it("clears queue after compilation", () => {
      engine.createNotification("author-1", "new_review", "Review", "Message");
      engine.compileDigest("author-1", "daily");
      const pending = engine.getPendingDigestEntries("author-1");
      assert.equal(pending.length, 0);
    });

    it("includes unread count in digest", () => {
      engine.createNotification("author-1", "new_review", "Review 1", "Msg 1");
      engine.createNotification("author-1", "new_review", "Review 2", "Msg 2");
      const digest = engine.compileDigest("author-1", "daily");
      assert(digest);
      assert(digest.unreadCount > 0);
    });

    it("tracks last digest sent time", () => {
      engine.createNotification("author-1", "new_review", "Review", "Message");
      engine.compileDigest("author-1", "daily");
      const lastTime = engine.getLastDigestTime("author-1");
      assert(lastTime);
      assert(lastTime > new Date(Date.now() - 60000)); // Less than 1 minute ago
    });
  });

  describe("event-based notifications", () => {
    let engine: AuthorNotificationEngine;

    beforeEach(() => {
      engine = new AuthorNotificationEngine();
    });

    it("notifyNewReview creates review notification", () => {
      const notif = engine.notifyNewReview(
        "author-1",
        "plugin-stripe",
        "user-reviewer",
        5,
        "Great plugin!",
      );
      assert.equal(notif.type, "new_review");
      assert(notif.message.includes("5★"));
      assert.equal(notif.pluginId, "plugin-stripe");
    });

    it("notifyDownloadMilestone for valid milestone", () => {
      const notif = engine.notifyDownloadMilestone("author-1", "plugin-stripe", 1000);
      assert(notif);
      assert.equal(notif.type, "download_milestone");
      assert(notif.message.includes("1000"));
    });

    it("notifyDownloadMilestone returns null for non-milestone number", () => {
      const notif = engine.notifyDownloadMilestone("author-1", "plugin-stripe", 999);
      assert.equal(notif, null);
    });

    it("notifySecurityAlert includes severity", () => {
      const notif = engine.notifySecurityAlert(
        "author-1",
        "plugin-stripe",
        "XSS vulnerability",
        "high",
      );
      assert.equal(notif.type, "security_alert");
      assert(notif.message.includes("HIGH"));
    });

    it("notifyRatingThreshold triggers on low rating", () => {
      const notif = engine.notifyRatingThreshold("author-1", "plugin-stripe", 3.5, 4.0);
      assert(notif);
      assert.equal(notif.type, "rating_threshold");
      assert(notif.message.includes("3.5"));
    });

    it("notifyRatingThreshold returns null if above threshold", () => {
      const notif = engine.notifyRatingThreshold("author-1", "plugin-stripe", 4.5, 4.0);
      assert.equal(notif, null);
    });

    it("notifyDependencyUpdate creates notification", () => {
      const notif = engine.notifyDependencyUpdate(
        "author-1",
        "plugin-stripe",
        "@stripe/api",
        "1.2.3",
      );
      assert.equal(notif.type, "dependency_update");
      assert(notif.message.includes("1.2.3"));
    });

    it("notifyCommunityDigest creates digest notification", () => {
      engine.setDigestSettings("author-1", "daily", ["new_review"]);
      engine.createNotification("author-1", "new_review", "Review", "Message");
      const digest = engine.compileDigest("author-1", "daily");

      if (digest) {
        const notif = engine.notifyCommunityDigest("author-1", digest);
        assert.equal(notif.type, "community_digest");
        assert(notif.message.includes("updates"));
      }
    });
  });

  describe("notification statistics", () => {
    let engine: AuthorNotificationEngine;

    beforeEach(() => {
      engine = new AuthorNotificationEngine();
    });

    it("counts total notifications", () => {
      engine.createNotification("author-1", "new_review", "1", "Msg");
      engine.createNotification("author-1", "new_review", "2", "Msg");
      engine.createNotification("author-1", "security_alert", "Alert", "Msg");

      const stats = engine.getNotificationStats("author-1");
      assert.equal(stats.totalNotifications, 3);
    });

    it("counts unread notifications", () => {
      const n1 = engine.createNotification("author-1", "new_review", "1", "Msg");
      engine.createNotification("author-1", "new_review", "2", "Msg");

      engine.markAsRead(n1.id);
      const stats = engine.getNotificationStats("author-1");
      assert.equal(stats.unreadCount, 1);
      assert.equal(stats.byStatus.read, 1);
      assert.equal(stats.byStatus.unread, 1);
    });

    it("counts by notification type", () => {
      engine.createNotification("author-1", "new_review", "Review", "Msg");
      engine.createNotification("author-1", "new_review", "Review 2", "Msg");
      engine.createNotification("author-1", "security_alert", "Alert", "Msg");

      const stats = engine.getNotificationStats("author-1");
      assert.equal(stats.byType.new_review, 2);
      assert.equal(stats.byType.security_alert, 1);
    });
  });
});
