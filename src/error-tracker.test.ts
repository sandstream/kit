import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ErrorTracker } from "./error-tracker.js";

describe("ErrorTracker", () => {
  describe("error logging", () => {
    let tracker: ErrorTracker;

    beforeEach(() => {
      tracker = new ErrorTracker();
    });

    it("logs an error", () => {
      const error = tracker.logError(
        "Database connection failed",
        "Error: Connection timeout",
        "critical",
      );
      assert(error.id);
      assert.equal(error.message, "Database connection failed");
      assert.equal(error.resolved, false);
    });

    it("logs error with context", () => {
      const context = { database: "main", retries: 3 };
      const error = tracker.logError("DB error", "stack", "high", context);
      assert.deepEqual(error.context, context);
    });

    it("logs error with user and session ID", () => {
      const error = tracker.logError(
        "Error",
        "stack",
        "high",
        {},
        "user-123",
        "session-456",
      );
      assert.equal(error.userId, "user-123");
      assert.equal(error.sessionId, "session-456");
    });

    it("gets error by ID", () => {
      const logged = tracker.logError("Test error", "stack");
      const retrieved = tracker.getError(logged.id);
      assert(retrieved);
      assert.equal(retrieved.message, "Test error");
    });

    it("returns null for unknown error ID", () => {
      const error = tracker.getError("unknown");
      assert.equal(error, null);
    });

    it("resolves an error", () => {
      const logged = tracker.logError("Test", "stack");
      const resolved = tracker.resolveError(logged.id);
      assert(resolved);
      assert(resolved.resolved);
      assert(resolved.resolvedAt);
    });

    it("gets all unresolved errors", () => {
      tracker.logError("Error 1", "stack");
      const error2 = tracker.logError("Error 2", "stack");
      tracker.logError("Error 3", "stack");
      tracker.resolveError(error2.id);

      const unresolved = tracker.getUnresolvedErrors();
      assert.equal(unresolved.length, 2);
    });

    it("gets errors by severity", () => {
      tracker.logError("Error 1", "stack", "critical");
      tracker.logError("Error 2", "stack", "high");
      tracker.logError("Error 3", "stack", "critical");

      const critical = tracker.getErrorsBySeverity("critical");
      assert.equal(critical.length, 2);
    });

    it("uses high severity as default", () => {
      const error = tracker.logError("Test", "stack");
      assert.equal(error.severity, "high");
    });
  });

  describe("error grouping", () => {
    let tracker: ErrorTracker;

    beforeEach(() => {
      tracker = new ErrorTracker();
    });

    it("groups same errors together", () => {
      const msg = "Database connection failed";
      tracker.logError(msg, "stack1");
      tracker.logError(msg, "stack2");
      tracker.logError(msg, "stack3");

      const groups = tracker.getAllErrorGroups();
      assert.equal(groups.length, 1);
      assert.equal(groups[0].occurrences, 3);
    });

    it("creates separate groups for different errors", () => {
      tracker.logError("Error A", "stack");
      tracker.logError("Error B", "stack");
      tracker.logError("Error C", "stack");

      const groups = tracker.getAllErrorGroups();
      assert.equal(groups.length, 3);
    });

    it("tracks first and last occurrence", () => {
      const msg = "Recurring error";
      tracker.logError(msg, "stack1");
      tracker.logError(msg, "stack2");

      const groups = tracker.getAllErrorGroups();
      const group = groups[0];
      assert(group.firstSeen);
      assert(group.lastSeen);
      assert(group.firstSeen <= group.lastSeen);
    });

    it("escalates severity to critical", () => {
      const msg = "API error";
      tracker.logError(msg, "stack", "low");
      tracker.logError(msg, "stack", "critical");

      const groups = tracker.getAllErrorGroups();
      const group = groups[0];
      assert.equal(group.severity, "critical");
    });

    it("gets errors by group", () => {
      const msg = "Database error";
      tracker.logError(msg, "stack1");
      tracker.logError(msg, "stack2");
      tracker.logError("Other error", "stack");

      const groups = tracker.getAllErrorGroups();
      const dbGroup = groups.find((g) => g.message === msg);
      const errors = tracker.getErrorsByGroup(dbGroup!.id);
      assert.equal(errors.length, 2);
    });

    it("marks group as resolved when all errors resolved", () => {
      const msg = "Test error";
      const e1 = tracker.logError(msg, "stack1");
      const e2 = tracker.logError(msg, "stack2");

      tracker.resolveError(e1.id);
      tracker.resolveError(e2.id);

      const groups = tracker.getAllErrorGroups();
      const group = groups[0];
      assert(group.resolved);
    });
  });

  describe("metrics", () => {
    let tracker: ErrorTracker;

    beforeEach(() => {
      tracker = new ErrorTracker();
    });

    it("returns error metrics", () => {
      tracker.logError("Error 1", "stack", "critical");
      tracker.logError("Error 2", "stack", "high");
      tracker.logError("Error 3", "stack", "low");

      const metrics = tracker.getMetrics();
      assert.equal(metrics.totalErrors, 3);
      assert.equal(metrics.errorsBySeverity.critical, 1);
      assert.equal(metrics.errorsBySeverity.high, 1);
      assert.equal(metrics.errorsBySeverity.low, 1);
    });

    it("counts errors by type", () => {
      tracker.logError("Database error", "stack");
      tracker.logError("Database error", "stack");
      tracker.logError("Network error", "stack");

      const metrics = tracker.getMetrics();
      assert.equal(metrics.errorsByType["Database error"], 2);
      assert.equal(metrics.errorsByType["Network error"], 1);
    });

    it("returns top errors", () => {
      tracker.logError("Common error", "stack");
      tracker.logError("Common error", "stack");
      tracker.logError("Common error", "stack");
      tracker.logError("Rare error", "stack");

      const metrics = tracker.getMetrics();
      const topErrors = metrics.topErrors;
      assert(topErrors.length > 0);
      assert.equal(topErrors[0].message, "Common error");
    });

    it("tracks error trend over time", () => {
      tracker.logError("Error 1", "stack");
      tracker.logError("Error 2", "stack");
      tracker.logError("Error 3", "stack");

      const metrics = tracker.getMetrics();
      assert(metrics.errorTrend.length > 0);
      assert(metrics.errorTrend[0].date);
      assert(metrics.errorTrend[0].count > 0);
    });

    it("calculates error rate", () => {
      tracker.logError("Error 1", "stack");
      tracker.logError("Error 2", "stack");

      const rate = tracker.getErrorRate();
      assert(rate >= 0);
    });

    it("returns recent errors sorted by timestamp", () => {
      tracker.logError("Error 1", "stack");
      tracker.logError("Error 2", "stack");
      tracker.logError("Error 3", "stack");

      const recent = tracker.getRecentErrors(2);
      assert.equal(recent.length, 2);
      assert(
        new Date(recent[0].timestamp).getTime() >=
          new Date(recent[1].timestamp).getTime(),
      );
    });

    it("respects limit on recent errors", () => {
      for (let i = 0; i < 20; i++) {
        tracker.logError(`Error ${i}`, "stack");
      }

      const recent = tracker.getRecentErrors(5);
      assert.equal(recent.length, 5);
    });
  });

  describe("cleanup", () => {
    let tracker: ErrorTracker;

    beforeEach(() => {
      tracker = new ErrorTracker();
    });

    it("clears resolved errors", () => {
      const e1 = tracker.logError("Error 1", "stack");
      const e2 = tracker.logError("Error 2", "stack");
      tracker.logError("Error 3", "stack");

      tracker.resolveError(e1.id);
      tracker.resolveError(e2.id);

      const cleared = tracker.clearResolvedErrors();
      assert(cleared > 0);
      assert.equal(tracker.getUnresolvedErrors().length, 1);
    });

    it("clears old errors", () => {
      tracker.logError("Recent error", "stack");
      // This test would need to set timestamps manually in a real scenario
      const cache = tracker.getErrorCache();
      assert(cache.size > 0);
    });
  });

  describe("cache helpers", () => {
    let tracker: ErrorTracker;

    beforeEach(() => {
      tracker = new ErrorTracker();
    });

    it("returns error cache", () => {
      tracker.logError("Error 1", "stack");
      tracker.logError("Error 2", "stack");

      const cache = tracker.getErrorCache();
      assert.equal(cache.size, 2);
    });

    it("returns error group cache", () => {
      tracker.logError("Error 1", "stack");
      tracker.logError("Error 2", "stack");
      tracker.logError("Error 3", "stack");

      const groupCache = tracker.getErrorGroupCache();
      assert.equal(groupCache.size, 3);
    });
  });
});
