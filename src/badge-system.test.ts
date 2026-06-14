import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  BadgeSystem,
  BADGE_DEFINITIONS,
  type PluginMetrics,
} from "./badge-system.js";

function makeMetrics(overrides: Partial<PluginMetrics> = {}): PluginMetrics {
  return {
    pluginId: "stripe/payments",
    authorId: "author-1",
    rating: 3.0,
    reviewsCount: 10,
    downloadsMonth: 100,
    downloadsWeek: 20,
    downloadsTotal: 500,
    trendingScore: 300,
    isOfficial: false,
    hasSecurityAudit: false,
    lastUpdateDays: 30,
    authorVerified: false,
    ...overrides,
  };
}

describe("BadgeSystem", () => {
  describe("initialization", () => {
    it("creates system instance", () => {
      const system = new BadgeSystem();
      assert(system);
    });

    it("exports badge definitions", () => {
      assert(BADGE_DEFINITIONS);
      assert(BADGE_DEFINITIONS.official);
      assert(BADGE_DEFINITIONS.top_rated);
      assert(BADGE_DEFINITIONS.trending);
    });

    it("has all 8 badge types defined", () => {
      const types = Object.keys(BADGE_DEFINITIONS);
      assert.equal(types.length, 8);
    });
  });

  describe("badge criteria — official", () => {
    let system: BadgeSystem;

    beforeEach(() => {
      system = new BadgeSystem();
    });

    it("awards official badge when isOfficial=true", () => {
      const metrics = makeMetrics({ isOfficial: true });
      assert.equal(system.evaluateBadge("official", metrics), true);
    });

    it("denies official badge when isOfficial=false", () => {
      const metrics = makeMetrics({ isOfficial: false });
      assert.equal(system.evaluateBadge("official", metrics), false);
    });
  });

  describe("badge criteria — top_rated", () => {
    let system: BadgeSystem;

    beforeEach(() => {
      system = new BadgeSystem();
    });

    it("awards top_rated with 4.8+ rating and 50+ reviews", () => {
      const metrics = makeMetrics({ rating: 4.9, reviewsCount: 100 });
      assert.equal(system.evaluateBadge("top_rated", metrics), true);
    });

    it("denies top_rated with low rating", () => {
      const metrics = makeMetrics({ rating: 4.5, reviewsCount: 100 });
      assert.equal(system.evaluateBadge("top_rated", metrics), false);
    });

    it("denies top_rated with few reviews", () => {
      const metrics = makeMetrics({ rating: 5.0, reviewsCount: 10 });
      assert.equal(system.evaluateBadge("top_rated", metrics), false);
    });

    it("awards at exactly 4.8 rating threshold", () => {
      const metrics = makeMetrics({ rating: 4.8, reviewsCount: 50 });
      assert.equal(system.evaluateBadge("top_rated", metrics), true);
    });
  });

  describe("badge criteria — trending", () => {
    let system: BadgeSystem;

    beforeEach(() => {
      system = new BadgeSystem();
    });

    it("awards trending with high score and weekly downloads", () => {
      const metrics = makeMetrics({ trendingScore: 800, downloadsWeek: 200 });
      assert.equal(system.evaluateBadge("trending", metrics), true);
    });

    it("denies trending with low trending score", () => {
      const metrics = makeMetrics({ trendingScore: 400, downloadsWeek: 200 });
      assert.equal(system.evaluateBadge("trending", metrics), false);
    });

    it("denies trending with low weekly downloads", () => {
      const metrics = makeMetrics({ trendingScore: 900, downloadsWeek: 50 });
      assert.equal(system.evaluateBadge("trending", metrics), false);
    });
  });

  describe("badge criteria — secure", () => {
    let system: BadgeSystem;

    beforeEach(() => {
      system = new BadgeSystem();
    });

    it("awards secure badge when audit complete", () => {
      const metrics = makeMetrics({ hasSecurityAudit: true });
      assert.equal(system.evaluateBadge("secure", metrics), true);
    });

    it("denies secure badge without audit", () => {
      const metrics = makeMetrics({ hasSecurityAudit: false });
      assert.equal(system.evaluateBadge("secure", metrics), false);
    });
  });

  describe("badge criteria — well_documented", () => {
    let system: BadgeSystem;

    beforeEach(() => {
      system = new BadgeSystem();
    });

    it("awards well_documented with docs url and 5+ pages", () => {
      const metrics = makeMetrics({
        docsUrl: "https://github.com/sandstream/kit",
        docsPageCount: 8,
      });
      assert.equal(system.evaluateBadge("well_documented", metrics), true);
    });

    it("denies when no docs url", () => {
      const metrics = makeMetrics({ docsPageCount: 10 });
      assert.equal(system.evaluateBadge("well_documented", metrics), false);
    });

    it("denies when fewer than 5 pages", () => {
      const metrics = makeMetrics({
        docsUrl: "https://docs.example.com",
        docsPageCount: 3,
      });
      assert.equal(system.evaluateBadge("well_documented", metrics), false);
    });
  });

  describe("badge criteria — verified", () => {
    let system: BadgeSystem;

    beforeEach(() => {
      system = new BadgeSystem();
    });

    it("awards verified when author is verified", () => {
      const metrics = makeMetrics({ authorVerified: true });
      assert.equal(system.evaluateBadge("verified", metrics), true);
    });

    it("denies verified for unverified author", () => {
      const metrics = makeMetrics({ authorVerified: false });
      assert.equal(system.evaluateBadge("verified", metrics), false);
    });
  });

  describe("badge criteria — popular", () => {
    let system: BadgeSystem;

    beforeEach(() => {
      system = new BadgeSystem();
    });

    it("awards popular with 1000+ monthly downloads", () => {
      const metrics = makeMetrics({ downloadsMonth: 1500 });
      assert.equal(system.evaluateBadge("popular", metrics), true);
    });

    it("denies popular below threshold", () => {
      const metrics = makeMetrics({ downloadsMonth: 500 });
      assert.equal(system.evaluateBadge("popular", metrics), false);
    });
  });

  describe("badge criteria — actively_maintained", () => {
    let system: BadgeSystem;

    beforeEach(() => {
      system = new BadgeSystem();
    });

    it("awards for update within 90 days", () => {
      const metrics = makeMetrics({ lastUpdateDays: 30 });
      assert.equal(system.evaluateBadge("actively_maintained", metrics), true);
    });

    it("awards at exactly 90 day threshold", () => {
      const metrics = makeMetrics({ lastUpdateDays: 90 });
      assert.equal(system.evaluateBadge("actively_maintained", metrics), true);
    });

    it("denies for stale plugin", () => {
      const metrics = makeMetrics({ lastUpdateDays: 180 });
      assert.equal(system.evaluateBadge("actively_maintained", metrics), false);
    });
  });

  describe("award and revoke", () => {
    let system: BadgeSystem;

    beforeEach(() => {
      system = new BadgeSystem();
    });

    it("awards badge and adds to plugin", () => {
      const badge = system.awardBadge("stripe/payments", "official");
      assert.equal(badge.type, "official");
      assert.equal(badge.icon, "⭐");

      assert.equal(system.hasBadge("stripe/payments", "official"), true);
    });

    it("does not duplicate badge on re-award", () => {
      system.awardBadge("stripe/payments", "official");
      system.awardBadge("stripe/payments", "official");

      const badges = system.getPluginBadges("stripe/payments");
      const officialBadges = badges.filter((b) => b.type === "official");
      assert.equal(officialBadges.length, 1);
    });

    it("revokes badge from plugin", () => {
      system.awardBadge("stripe/payments", "trending");
      const success = system.revokeBadge(
        "stripe/payments",
        "trending",
        "Score dropped",
      );

      assert.equal(success, true);
      assert.equal(system.hasBadge("stripe/payments", "trending"), false);
    });

    it("returns false revoking non-existent badge", () => {
      const success = system.revokeBadge(
        "stripe/payments",
        "official",
        "test",
      );
      assert.equal(success, false);
    });
  });

  describe("sync badges", () => {
    let system: BadgeSystem;

    beforeEach(() => {
      system = new BadgeSystem();
    });

    it("awards badges when criteria met", () => {
      const metrics = makeMetrics({
        isOfficial: true,
        rating: 4.9,
        reviewsCount: 100,
      });
      const report = system.syncBadges("stripe/payments", metrics);

      assert(report.passed.includes("official"));
      assert(report.passed.includes("top_rated"));
    });

    it("revokes badges when criteria no longer met", () => {
      system.awardBadge("stripe/payments", "trending");

      const metrics = makeMetrics({ trendingScore: 100, downloadsWeek: 10 });
      const report = system.syncBadges("stripe/payments", metrics);

      assert.equal(system.hasBadge("stripe/payments", "trending"), false);
      assert(report.failed.includes("trending"));
    });

    it("returns full report with passed and failed", () => {
      const metrics = makeMetrics({ isOfficial: true });
      const report = system.syncBadges("stripe/payments", metrics);

      assert(report.passed.length > 0);
      assert(report.failed.length > 0);
      assert(Array.isArray(report.badges));
      assert(Array.isArray(report.auditLog));
    });

    it("report includes all evaluated criteria", () => {
      const metrics = makeMetrics();
      const report = system.syncBadges("stripe/payments", metrics);

      assert.equal(report.evaluated.length, 8);
    });
  });

  describe("queries", () => {
    let system: BadgeSystem;

    beforeEach(() => {
      system = new BadgeSystem();
    });

    it("getPluginsByBadge returns correct plugins", () => {
      system.awardBadge("stripe/payments", "official");
      system.awardBadge("supabase/db", "official");
      system.awardBadge("stripe/payments", "top_rated");

      const official = system.getPluginsByBadge("official");
      assert.equal(official.length, 2);
      assert(official.includes("stripe/payments"));
      assert(official.includes("supabase/db"));
    });

    it("getBadgeStats returns counts per type", () => {
      system.awardBadge("stripe/payments", "official");
      system.awardBadge("supabase/db", "official");
      system.awardBadge("stripe/payments", "trending");

      const stats = system.getBadgeStats();
      assert.equal(stats.official, 2);
      assert.equal(stats.trending, 1);
      assert.equal(stats.secure, 0);
    });

    it("getAuditLog returns plugin-specific entries", () => {
      system.awardBadge("stripe/payments", "official");
      system.awardBadge("supabase/db", "official");

      const log = system.getAuditLog("stripe/payments");
      assert.equal(log.length, 1);
      assert.equal(log[0].pluginId, "stripe/payments");
    });

    it("getAuditLog without filter returns all", () => {
      system.awardBadge("stripe/payments", "official");
      system.awardBadge("supabase/db", "trending");

      const log = system.getAuditLog();
      assert.equal(log.length, 2);
    });
  });

  describe("display helpers", () => {
    let system: BadgeSystem;

    beforeEach(() => {
      system = new BadgeSystem();
    });

    it("formats badges for display", () => {
      system.awardBadge("stripe/payments", "official");
      system.awardBadge("stripe/payments", "top_rated");

      const display = system.formatBadgesForDisplay("stripe/payments");
      assert(display.includes("⭐"));
      assert(display.includes("Official"));
      assert(display.includes("🏆"));
    });

    it("returns empty string for plugin with no badges", () => {
      const display = system.formatBadgesForDisplay("unknown/plugin");
      assert.equal(display, "");
    });

    it("getBadgeDefinitions returns all definitions", () => {
      const defs = system.getBadgeDefinitions();
      assert.equal(Object.keys(defs).length, 8);
      assert(defs.official.icon);
      assert(defs.official.description);
    });
  });

  describe("evaluateAllBadges", () => {
    let system: BadgeSystem;

    beforeEach(() => {
      system = new BadgeSystem();
    });

    it("returns empty for plugin meeting no criteria", () => {
      const metrics = makeMetrics();
      const earned = system.evaluateAllBadges(metrics);
      // actively_maintained should still pass (lastUpdateDays: 30 <= 90)
      assert(earned.includes("actively_maintained"));
    });

    it("returns all applicable badges for stellar plugin", () => {
      const metrics = makeMetrics({
        isOfficial: true,
        rating: 4.9,
        reviewsCount: 100,
        trendingScore: 900,
        downloadsWeek: 500,
        downloadsMonth: 5000,
        hasSecurityAudit: true,
        docsUrl: "https://github.com/sandstream/kit",
        docsPageCount: 10,
        authorVerified: true,
        lastUpdateDays: 7,
      });
      const earned = system.evaluateAllBadges(metrics);

      assert(earned.includes("official"));
      assert(earned.includes("top_rated"));
      assert(earned.includes("trending"));
      assert(earned.includes("secure"));
      assert(earned.includes("well_documented"));
      assert(earned.includes("verified"));
      assert(earned.includes("popular"));
      assert(earned.includes("actively_maintained"));
    });
  });
});
