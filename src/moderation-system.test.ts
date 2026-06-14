import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  ModerationSystem,
  type ModerationReport,
  type ContentType,
  type ViolationType,
} from "./moderation-system.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeReport(
  system: ModerationSystem,
  contentId: string,
  contentType: ContentType = "review",
  overrides: { reason?: ViolationType; reportedBy?: string; description?: string } = {},
): ModerationReport {
  return system.fileReport(
    contentId,
    contentType,
    overrides.reportedBy || "user-reporter",
    overrides.reason || "spam",
    overrides.description || "This looks like spam",
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("ModerationSystem", () => {
  describe("initialization", () => {
    it("creates system instance", () => {
      const system = new ModerationSystem();
      assert(system);
    });

    it("starts with empty caches", () => {
      const system = new ModerationSystem();
      assert.equal(system.getReportsCache().size, 0);
      assert.equal(system.getActionsCache().size, 0);
      assert.equal(system.getAppealCache().size, 0);
    });
  });

  describe("fileReport", () => {
    let system: ModerationSystem;

    beforeEach(() => {
      system = new ModerationSystem();
    });

    it("files a moderation report", () => {
      const report = makeReport(system, "review-1");
      assert(report.id);
      assert.equal(report.contentId, "review-1");
      assert.equal(report.status, "pending");
    });

    it("stores report metadata", () => {
      const report = makeReport(system, "review-1", "review", {
        reason: "abuse",
        reportedBy: "user-a",
        description: "Offensive language",
      });
      assert.equal(report.reason, "abuse");
      assert.equal(report.reportedBy, "user-a");
      assert.equal(report.description, "Offensive language");
    });

    it("records evidence", () => {
      const evidence = ["screenshot.png", "logs.txt"];
      const report = system.fileReport("review-1", "review", "user-a", "spam", "Spam", evidence);
      assert.deepEqual(report.evidence, evidence);
    });

    it("supports all content types", () => {
      const types: ContentType[] = ["plugin", "review", "comment", "author"];
      for (const type of types) {
        const report = makeReport(system, `content-${type}`, type);
        assert.equal(report.contentType, type);
      }
    });
  });

  describe("getReport / getContentReports", () => {
    let system: ModerationSystem;

    beforeEach(() => {
      system = new ModerationSystem();
      makeReport(system, "review-1");
      makeReport(system, "review-1", "review", { reason: "abuse" });
      makeReport(system, "review-2");
    });

    it("retrieves report by ID", () => {
      const reports = [...system.getReportsCache().values()];
      const found = system.getReport(reports[0].id);
      assert(found);
      assert.equal(found.id, reports[0].id);
    });

    it("returns null for unknown report", () => {
      const report = system.getReport("unknown");
      assert.equal(report, null);
    });

    it("gets all reports for content", () => {
      const reports = system.getContentReports("review-1");
      assert.equal(reports.length, 2);
      assert(reports.every((r) => r.contentId === "review-1"));
    });

    it("returns empty for unknown content", () => {
      const reports = system.getContentReports("unknown");
      assert.equal(reports.length, 0);
    });
  });

  describe("moderation queue", () => {
    let system: ModerationSystem;

    beforeEach(() => {
      system = new ModerationSystem();
    });

    it("adds reports to queue with low priority for 1 report", () => {
      makeReport(system, "content-1");
      const queue = system.getQueue();
      assert.equal(queue.length, 1);
      assert.equal(queue[0].priority, "low");
    });

    it("escalates priority with multiple reports", () => {
      for (let i = 0; i < 3; i++) {
        makeReport(system, "content-1");
      }
      const queue = system.getQueue();
      assert.equal(queue[0].priority, "medium");
    });

    it("escalates to high priority at 5 reports", () => {
      for (let i = 0; i < 5; i++) {
        makeReport(system, "content-1");
      }
      const queue = system.getQueue();
      assert.equal(queue[0].priority, "high");
    });

    it("escalates to critical at 10 reports", () => {
      for (let i = 0; i < 10; i++) {
        makeReport(system, "content-1");
      }
      const queue = system.getQueue();
      assert.equal(queue[0].priority, "critical");
    });

    it("prioritizes high-severity violations", () => {
      system.fileReport("content-1", "review", "user-a", "spam", "spam");
      system.fileReport("content-2", "review", "user-b", "malware", "malware alert");

      const queue = system.getQueue();
      const malwareEntry = queue.find((q) => q.contentId === "content-2");
      assert(malwareEntry);
      assert.equal(malwareEntry.priority, "critical");
    });

    it("sorts queue by priority", () => {
      for (let i = 0; i < 10; i++) system.fileReport(`content-${i}`, "review", "user", "spam", "");

      const queue = system.getQueue();
      for (let i = 1; i < queue.length; i++) {
        const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
        assert(
          priorityOrder[queue[i - 1].priority as keyof typeof priorityOrder] <=
            priorityOrder[queue[i].priority as keyof typeof priorityOrder],
        );
      }
    });

    it("respects limit parameter", () => {
      for (let i = 0; i < 30; i++) system.fileReport(`content-${i}`, "review", "user", "spam", "");
      const queue = system.getQueue(5);
      assert.equal(queue.length, 5);
    });

    it("provides queue stats", () => {
      for (let i = 0; i < 3; i++) system.fileReport(`c-${i}`, "review", "user", "spam", "");
      const stats = system.getQueueStats();
      assert.equal(stats.total, 3);
      assert(stats.low > 0);
    });
  });

  describe("detectSpam", () => {
    let system: ModerationSystem;

    beforeEach(() => {
      system = new ModerationSystem();
    });

    it("detects abusive language", () => {
      const signals = system.detectSpam("I hate this stupid plugin", {});
      assert(signals.hasAbusiveLanguage);
      assert(signals.score > 0);
    });

    it("detects excessive links", () => {
      const content = "Check out https://example.com and https://other.com and https://third.com and https://fourth.com";
      const signals = system.detectSpam(content, {});
      assert(signals.hasExcessiveLinks);
      assert(signals.score > 0);
    });

    it("detects all-caps text", () => {
      const signals = system.detectSpam("THIS IS SPAM AND YOU SHOULD BUY NOW", {});
      assert(signals.hasSuspiciousPatterns);
      assert(signals.score > 0);
    });

    it("detects repeated characters", () => {
      const signals = system.detectSpam("BUYYY NOOOWWWW!!!!!!", {});
      assert(signals.hasSuspiciousPatterns);
    });

    it("detects spam keywords", () => {
      const signals = system.detectSpam("LIMITED OFFER - BUY NOW GUARANTEED!", {});
      assert(signals.hasSuspiciousPatterns);
    });

    it("detects new accounts", () => {
      const createdAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
      const signals = system.detectSpam("normal comment", { createdAt });
      assert(signals.isNewAccount);
      assert(signals.score > 0);
    });

    it("does not flag old accounts as new", () => {
      const createdAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const signals = system.detectSpam("normal comment", { createdAt });
      assert(!signals.isNewAccount);
    });

    it("scores legitimate content as low", () => {
      const signals = system.detectSpam("This is a legitimate review with helpful information.", {});
      assert(signals.score < 20);
    });

    it("scores spam as high", () => {
      const signals = system.detectSpam(
        "BUY NOW!!! LIMITED OFFER!!! CLICK HERE NOW https://spam.com https://spam2.com https://spam3.com",
        { createdAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString() },
      );
      assert(signals.score >= 40);
    });
  });

  describe("takeAction", () => {
    let system: ModerationSystem;
    let reportId: string;

    beforeEach(() => {
      system = new ModerationSystem();
      const report = makeReport(system, "review-1", "review", { reportedBy: "user-bad" });
      reportId = report.id;
    });

    it("issues a warning", () => {
      const action = system.takeAction(reportId, "review-1", "warning", "Misleading content");
      assert.equal(action.action, "warning");
      assert.equal(action.reason, "Misleading content");
    });

    it("unpublishes content", () => {
      const action = system.takeAction(reportId, "review-1", "unpublish", "Violates guidelines");
      assert.equal(action.action, "unpublish");
    });

    it("suspends user temporarily", () => {
      const duration = 7; // days
      const action = system.takeAction(reportId, "review-1", "suspend_user", "Abuse", duration);
      assert.equal(action.action, "suspend_user");
      assert.equal(action.duration, duration);
    });

    it("bans user permanently", () => {
      const action = system.takeAction(reportId, "review-1", "ban_user", "Repeated abuse");
      assert.equal(action.action, "ban_user");
      assert.equal(action.duration, undefined);
    });

    it("updates report status after action", () => {
      system.takeAction(reportId, "review-1", "unpublish", "Violates guidelines");
      const report = system.getReport(reportId);
      assert.equal(report?.status, "approved");
    });

    it("tracks suspension expiration", () => {
      system.takeAction(reportId, "review-1", "suspend_user", "Abuse", 7);
      assert(system.isSuspended("user-bad"));
    });

    it("tracks permanent bans", () => {
      system.takeAction(reportId, "review-1", "ban_user", "Repeated abuse");
      assert(system.isBanned("user-bad"));
    });

    it("gets suspension status", () => {
      system.takeAction(reportId, "review-1", "suspend_user", "Abuse", 14);
      const status = system.getSuspensionStatus("user-bad");
      assert(status);
      assert(status.until > new Date());
      assert.equal(status.reason, "Abuse");
    });
  });

  describe("fileAppeal", () => {
    let system: ModerationSystem;
    let actionId: string;
    let reportId: string;

    beforeEach(() => {
      system = new ModerationSystem();
      const report = makeReport(system, "review-1");
      reportId = report.id;
      const action = system.takeAction(reportId, "review-1", "suspend_user", "Abuse", 7);
      actionId = action.id;
    });

    it("files an appeal against an action", () => {
      const appeal = system.fileAppeal(
        actionId,
        reportId,
        "review-1",
        "user-bad",
        "I did not violate guidelines",
      );
      assert(appeal.id);
      assert.equal(appeal.status, "pending");
    });

    it("updates report status to appealed", () => {
      system.fileAppeal(actionId, reportId, "review-1", "user-bad", "Appeal reason");
      const report = system.getReport(reportId);
      assert.equal(report?.status, "appealed");
    });

    it("records appeal evidence", () => {
      const evidence = ["context.txt", "explanation.pdf"];
      const appeal = system.fileAppeal(
        actionId,
        reportId,
        "review-1",
        "user-bad",
        "Appeal reason",
        evidence,
      );
      assert.deepEqual(appeal.evidence, evidence);
    });

    it("retrieves appeal by ID", () => {
      const appeal = system.fileAppeal(actionId, reportId, "review-1", "user-bad", "Appeal");
      const found = system.getAppeal(appeal.id);
      assert.equal(found?.id, appeal.id);
    });

    it("returns null for unknown appeal", () => {
      const appeal = system.getAppeal("unknown");
      assert.equal(appeal, null);
    });
  });

  describe("reviewAppeal", () => {
    let system: ModerationSystem;
    let actionId: string;
    let reportId: string;
    let appealId: string;

    beforeEach(() => {
      system = new ModerationSystem();
      const report = makeReport(system, "review-1", "review", { reportedBy: "user-bad" });
      reportId = report.id;
      const action = system.takeAction(reportId, "review-1", "suspend_user", "Abuse", 7);
      actionId = action.id;
      const appeal = system.fileAppeal(actionId, reportId, "review-1", "user-bad", "I was wronged");
      appealId = appeal.id;
    });

    it("upholds appeal decision", () => {
      system.reviewAppeal(appealId, "moderator-1", "upheld", "Appeal rejected");
      const appeal = system.getAppeal(appealId);
      assert.equal(appeal?.status, "upheld");
      assert.equal(appeal?.reviewedBy, "moderator-1");
    });

    it("overturns appeal decision", () => {
      system.reviewAppeal(appealId, "moderator-1", "overturned", "Decision reversed");
      const appeal = system.getAppeal(appealId);
      assert.equal(appeal?.status, "overturned");
    });

    it("removes suspension when appeal overturned", () => {
      assert(system.isSuspended("user-bad"));
      system.reviewAppeal(appealId, "moderator-1", "overturned", "Decision reversed");
      assert(!system.isSuspended("user-bad"));
    });

    it("removes ban when appeal overturned", () => {
      const report2 = makeReport(system, "review-2", "review", { reportedBy: "user-bad2" });
      const action2 = system.takeAction(report2.id, "review-2", "ban_user", "Bad");
      const appeal2 = system.fileAppeal(action2.id, report2.id, "review-2", "user-bad2", "Appeal");

      assert(system.isBanned("user-bad2"));
      system.reviewAppeal(appeal2.id, "mod", "overturned", "Overturned");
      assert(!system.isBanned("user-bad2"));
    });

    it("returns null for non-pending appeal", () => {
      system.reviewAppeal(appealId, "mod", "upheld", "Upheld");
      const result = system.reviewAppeal(appealId, "mod", "upheld", "Try again");
      assert.equal(result, null);
    });

    it("gets pending appeals", () => {
      system.fileAppeal(actionId, reportId, "review-1", "user-bad", "Appeal 1");
      const report2 = makeReport(system, "review-2", "review", { reportedBy: "user-2" });
      const action2 = system.takeAction(report2.id, "review-2", "warning", "Warning");
      system.fileAppeal(action2.id, report2.id, "review-2", "user-2", "Appeal 2");

      const pending = system.getPendingAppeals();
      assert(pending.length >= 2);
      assert(pending.every((a) => a.status === "pending"));
    });
  });

  describe("community guidelines", () => {
    let system: ModerationSystem;

    beforeEach(() => {
      system = new ModerationSystem();
    });

    it("registers a guideline", () => {
      const guideline = system.registerGuideline(
        "No spam",
        "Do not post spam or promotional content",
        ["Buy my plugin!", "Limited time offer"],
        "warning",
      );
      assert(guideline.id);
      assert.equal(guideline.title, "No spam");
      assert.equal(guideline.active, true);
    });

    it("retrieves guideline by ID", () => {
      const reg = system.registerGuideline("Respect", "Be respectful", [], "warning");
      const found = system.getGuideline(reg.id);
      assert.equal(found?.id, reg.id);
    });

    it("returns null for unknown guideline", () => {
      const found = system.getGuideline("unknown");
      assert.equal(found, null);
    });

    it("gets only active guidelines", () => {
      system.registerGuideline("Active", "Stay active", [], "warning");
      const inactive = system.registerGuideline("Inactive", "Will disable", [], "warning");
      system.deactivateGuideline(inactive.id);

      const active = system.getActiveGuidelines();
      assert(active.every((g) => g.active));
      assert(!active.map((g) => g.id).includes(inactive.id));
    });

    it("deactivates guideline", () => {
      const guideline = system.registerGuideline("Test", "Test", [], "warning");
      const deactivated = system.deactivateGuideline(guideline.id);
      assert(deactivated);
      const found = system.getGuideline(guideline.id);
      assert(!found?.active);
    });
  });

  describe("moderation stats", () => {
    let system: ModerationSystem;

    beforeEach(() => {
      system = new ModerationSystem();
    });

    it("counts total reports", () => {
      makeReport(system, "c1");
      makeReport(system, "c2");
      makeReport(system, "c3");
      const stats = system.getModerationStats();
      assert.equal(stats.totalReports, 3);
    });

    it("counts approved reports", () => {
      const r1 = makeReport(system, "c1");
      system.takeAction(r1.id, "c1", "unpublish", "Bad");
      makeReport(system, "c2");
      const stats = system.getModerationStats();
      assert.equal(stats.approvedCount, 1);
    });

    it("counts suspensions and bans", () => {
      const r1 = makeReport(system, "c1", "review", { reportedBy: "user-1" });
      const r2 = makeReport(system, "c2", "review", { reportedBy: "user-2" });
      system.takeAction(r1.id, "c1", "suspend_user", "Spam", 7);
      system.takeAction(r2.id, "c2", "ban_user", "Abuse");
      const stats = system.getModerationStats();
      assert.equal(stats.suspensionsCount, 1);
      assert.equal(stats.bansCount, 1);
    });

    it("returns all stats", () => {
      const stats = system.getModerationStats();
      assert(typeof stats.totalReports === "number");
      assert(typeof stats.approvedCount === "number");
      assert(typeof stats.averageResolutionTimeMs === "number");
    });
  });
});
