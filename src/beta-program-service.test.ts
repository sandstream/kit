import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { BetaProgramService } from "./beta-program-service.js";

describe("BetaProgramService", () => {
  let service: BetaProgramService;
  let mockDb: any;

  beforeEach(() => {
    mockDb = {
      query: async (sql: string, params: any[]) => {
        if (sql.includes("INSERT INTO beta_developers")) {
          return {
            rows: [{
              id: params[0],
              email: params[1],
              name: params[2],
              organization: params[3],
              enrolled_at: new Date().toISOString(),
              status: params[4],
            }],
          };
        }
        if (sql.includes("INSERT INTO plugin_feedback")) {
          return {
            rows: [{
              id: params[0],
              plugin_id: params[1],
              developer_id: params[2],
              rating: params[3],
              category: params[4],
              title: params[5],
              description: params[6],
              severity: params[7] || "medium",
              status: params[8],
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            }],
          };
        }
        if (sql.includes("SELECT * FROM plugin_feedback WHERE plugin_id")) {
          return {
            rows: [
              {
                id: "feedback-1",
                plugin_id: params[0],
                developer_id: "dev-1",
                rating: 4,
                category: "usability",
                title: "Confusing error message",
                description: "Error handling needs improvement",
                severity: "medium",
                status: "open",
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              },
            ],
          };
        }
        if (sql.includes("SELECT * FROM plugin_feedback WHERE developer_id")) {
          return {
            rows: [
              {
                id: "feedback-1",
                plugin_id: "plugin-1",
                developer_id: params[0],
                rating: 4,
                category: "usability",
                title: "Good UX",
                description: "Easy to use",
                severity: "low",
                status: "open",
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              },
            ],
          };
        }
        if (sql.includes("COUNT(*) as feedback_count") && sql.includes("beta_developers bd")) {
          return {
            rows: [{
              id: params[0],
              email: "dev@example.com",
              name: "Developer",
              organization: "Acme Corp",
              enrolled_at: new Date().toISOString(),
              status: "active",
              feedback_count: 5,
              plugins_tested: ["plugin-1", "plugin-2"],
              last_activity_at: new Date().toISOString(),
            }],
          };
        }
        if (sql.includes("SELECT * FROM beta_developers WHERE status")) {
          return {
            rows: Array.from({ length: Math.min(params[1] || 50, 10) }, (_, i) => ({
              id: `dev-${i}`,
              email: `dev${i}@example.com`,
              name: `Developer ${i}`,
              organization: "Company",
              enrolled_at: new Date().toISOString(),
              status: "active",
              feedback_count: 3 + i,
              last_activity_at: new Date().toISOString(),
            })),
          };
        }
        if (sql.includes("COUNT(*) as enrolled FROM beta_developers")) {
          return { rows: [{ enrolled: 15 }] };
        }
        if (sql.includes("COUNT(*) as total FROM plugin_feedback")) {
          return { rows: [{ total: 42 }] };
        }
        if (sql.includes("COUNT(*) as total FROM certification_refinements")) {
          return { rows: [{ total: 3 }] };
        }
        if (sql.includes("category") && sql.includes("COUNT(*)") && sql.includes("plugin_feedback")) {
          // Feedback by category
          return {
            rows: [
              { category: "usability", count: 15 },
              { category: "bug", count: 12 },
              { category: "documentation", count: 10 },
            ],
          };
        }
        if (sql.includes("severity") && sql.includes("COUNT(*)") && sql.includes("plugin_feedback")) {
          // Feedback by severity
          return {
            rows: [
              { severity: "medium", count: 20 },
              { severity: "low", count: 15 },
              { severity: "high", count: 7 },
            ],
          };
        }
        if (sql.includes("AVG(rating)")) {
          return { rows: [{ avg: "4.2" }] };
        }
        return { rows: [] };
      },
    };

    service = new BetaProgramService(mockDb);
  });

  describe("enrollDeveloper", () => {
    it("enrolls developer in beta program", async () => {
      const developer = await service.enrollDeveloper(
        "john@example.com",
        "John Developer",
        "Acme Corp",
      );
      assert.equal(developer.email, "john@example.com");
      assert.equal(developer.name, "John Developer");
      assert.equal(developer.organization, "Acme Corp");
      assert.equal(developer.status, "active");
    });

    it("generates unique developer IDs", async () => {
      const dev1 = await service.enrollDeveloper("dev1@example.com", "Dev 1");
      const dev2 = await service.enrollDeveloper("dev2@example.com", "Dev 2");
      assert.notEqual(dev1.id, dev2.id);
    });
  });

  describe("submitFeedback", () => {
    it("submits plugin feedback", async () => {
      const feedback = await service.submitFeedback(
        "plugin-1",
        "dev-1",
        4,
        "usability",
        "Confusing UI",
        "The settings page is hard to navigate",
        "medium",
      );
      assert.equal(feedback.rating, 4);
      assert.equal(feedback.category, "usability");
      assert.equal(feedback.status, "open");
    });

    it("validates rating range", async () => {
      await assert.rejects(
        () => service.submitFeedback("plugin-1", "dev-1", 6, "bug", "title", "desc"),
        /Rating must be between 1 and 5/,
      );
    });
  });

  describe("getPluginFeedback", () => {
    it("retrieves feedback for plugin", async () => {
      const feedback = await service.getPluginFeedback("plugin-1");
      assert.ok(Array.isArray(feedback));
      if (feedback.length > 0) {
        assert.equal(feedback[0].pluginId, "plugin-1");
      }
    });
  });

  describe("getDeveloperFeedback", () => {
    it("retrieves feedback from developer", async () => {
      const feedback = await service.getDeveloperFeedback("dev-1");
      assert.ok(Array.isArray(feedback));
    });
  });

  describe("getDeveloperProfile", () => {
    it("has getDeveloperProfile method", () => {
      assert.ok(typeof service.getDeveloperProfile === 'function');
    });
  });

  describe("getBetaDevelopers", () => {
    it("has getBetaDevelopers method", () => {
      assert.ok(typeof service.getBetaDevelopers === 'function');
    });
  });

  describe("getBetaProgramStatus", () => {
    it("returns beta program status", async () => {
      const status = await service.getBetaProgramStatus();
      assert.equal(status.name, "kit Community Beta Launch");
      assert.equal(status.status, "active");
      assert.ok(status.enrolledDevelopers >= 0);
      assert.ok(status.feedbackItems >= 0);
      assert.ok(status.refinementsProposed >= 0);
    });
  });

  describe("getFeedbackAnalytics", () => {
    it("returns feedback analytics", async () => {
      const analytics = await service.getFeedbackAnalytics();
      assert.ok(typeof analytics.totalFeedback === "number");
      assert.ok(Array.isArray(analytics.byCategory));
      assert.ok(Array.isArray(analytics.bySeverity));
      assert.ok(typeof analytics.avgRating === "number");
    });

    it("includes category breakdown", async () => {
      const analytics = await service.getFeedbackAnalytics();
      if (analytics.byCategory.length > 0) {
        assert.ok(analytics.byCategory[0].category);
        assert.ok(typeof analytics.byCategory[0].count === "number");
      }
    });
  });

  describe("identifyRefinements", () => {
    it("identifies certification refinements from feedback", async () => {
      const refinements = await service.identifyRefinements();
      assert.ok(Array.isArray(refinements));
    });
  });
});
