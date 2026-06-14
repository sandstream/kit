import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as AuditLogging from "./audit-logging-service.js";

describe("audit-logging-service", () => {
  describe("recordAuditEntry", () => {
    it("records audit entry with success status", () => {
      const { entry, error } = AuditLogging.recordAuditEntry(
        "create",
        "team",
        "team-123",
        "user-456",
        "John Doe",
        "success",
        { team_name: "Dev Team" },
        "low",
      );

      assert.ok(!error);
      assert.ok(entry.id);
      assert.equal(entry.action, "create");
      assert.equal(entry.resource, "team");
      assert.equal(entry.status, "success");
    });

    it("records audit entry with failure status", () => {
      const { entry } = AuditLogging.recordAuditEntry(
        "update",
        "permission",
        "perm-789",
        "user-789",
        "Admin User",
        "failure",
        { reason: "Unauthorized" },
        "high",
      );

      assert.equal(entry.status, "failure");
      assert.equal(entry.severity, "high");
    });

    it("includes optional fields when provided", () => {
      const { entry } = AuditLogging.recordAuditEntry(
        "delete",
        "member",
        "member-123",
        "user-admin",
        "Admin",
        "success",
        {},
        "critical",
        "team-456",
        "192.168.1.1",
      );

      assert.equal(entry.team_id, "team-456");
      assert.equal(entry.actor_ip, "192.168.1.1");
    });
  });

  describe("recordChangeHistory", () => {
    it("records change history", () => {
      const previousState = { name: "Old Name", status: "active" };
      const currentState = { name: "New Name", status: "active" };

      const { history } = AuditLogging.recordChangeHistory(
        "team-123",
        "team",
        "updated",
        currentState,
        "user-admin",
        "Admin User",
        previousState,
        "Renamed for clarity",
      );

      assert.ok(history.id);
      assert.equal(history.resource_id, "team-123");
      assert.equal(history.change_type, "updated");
      assert.equal(history.reason, "Renamed for clarity");
      assert.deepEqual(history.previous_state, previousState);
      assert.deepEqual(history.current_state, currentState);
    });

    it("records deletion with current state", () => {
      const state = { id: "member-789", user_id: "user-x", role: "guest" };

      const { history } = AuditLogging.recordChangeHistory(
        "member-789",
        "member",
        "deleted",
        state,
        "user-admin",
        "Admin",
      );

      assert.equal(history.change_type, "deleted");
      assert.deepEqual(history.current_state, state);
    });
  });

  describe("queryAuditEntries", () => {
    it("queries all audit entries", () => {
      AuditLogging.recordAuditEntry(
        "create",
        "team",
        "q-team-1",
        "q-user-1",
        "User 1",
      );
      AuditLogging.recordAuditEntry(
        "read",
        "member",
        "q-member-1",
        "q-user-2",
        "User 2",
      );

      const { entries, total } = AuditLogging.queryAuditEntries({});

      assert.ok(entries.length >= 2);
      assert.ok(total >= 2);
    });

    it("filters by action", () => {
      AuditLogging.recordAuditEntry(
        "create",
        "team",
        "q-team-2",
        "q-user-3",
        "User 3",
      );
      AuditLogging.recordAuditEntry(
        "delete",
        "team",
        "q-team-3",
        "q-user-4",
        "User 4",
      );

      const { entries } = AuditLogging.queryAuditEntries({ action: "create" });

      assert.ok(entries.every((e) => e.action === "create"));
    });

    it("filters by resource", () => {
      AuditLogging.recordAuditEntry(
        "read",
        "plugin",
        "q-plugin-1",
        "q-user-5",
        "User 5",
      );
      AuditLogging.recordAuditEntry(
        "update",
        "workflow",
        "q-workflow-1",
        "q-user-6",
        "User 6",
      );

      const { entries } = AuditLogging.queryAuditEntries({ resource: "plugin" });

      assert.ok(entries.every((e) => e.resource === "plugin"));
    });

    it("filters by status", () => {
      AuditLogging.recordAuditEntry(
        "execute",
        "workflow",
        "q-workflow-2",
        "q-user-7",
        "User 7",
        "success",
      );
      AuditLogging.recordAuditEntry(
        "execute",
        "workflow",
        "q-workflow-3",
        "q-user-8",
        "User 8",
        "failure",
      );

      const { entries } = AuditLogging.queryAuditEntries({ status: "failure" });

      assert.ok(entries.every((e) => e.status === "failure"));
    });

    it("filters by actor", () => {
      AuditLogging.recordAuditEntry(
        "create",
        "role",
        "q-role-1",
        "specific-user",
        "Specific User",
      );

      const { entries } = AuditLogging.queryAuditEntries({ actor_id: "specific-user" });

      assert.ok(entries.every((e) => e.actor_id === "specific-user"));
    });

    it("respects pagination", () => {
      const { entries: page1 } = AuditLogging.queryAuditEntries({ limit: 5, offset: 0 });
      const { entries: page2 } = AuditLogging.queryAuditEntries({ limit: 5, offset: 5 });

      assert.ok(page1.length > 0);
      if (page2.length > 0) {
        assert.notEqual(page1[0]?.id, page2[0]?.id);
      }
    });
  });

  describe("getUserActivity", () => {
    it("gets user activity after recording entries", () => {
      const userId = "activity-user";
      AuditLogging.recordAuditEntry(
        "create",
        "team",
        "a-team-1",
        userId,
        "Activity User",
      );
      AuditLogging.recordAuditEntry(
        "update",
        "member",
        "a-member-1",
        userId,
        "Activity User",
      );

      const { activity, error } = AuditLogging.getUserActivity(userId);

      assert.ok(!error);
      assert.ok(activity);
      assert.equal(activity?.action_count, 2);
      assert.equal(activity?.user_id, userId);
    });

    it("returns error for nonexistent user", () => {
      const { activity, error } = AuditLogging.getUserActivity("nonexistent");

      assert.ok(error);
      assert.ok(!activity);
    });
  });

  describe("listUserActivities", () => {
    it("lists all user activities", () => {
      AuditLogging.recordAuditEntry(
        "read",
        "plugin",
        "l-plugin-1",
        "user-list-1",
        "User 1",
      );
      AuditLogging.recordAuditEntry(
        "read",
        "plugin",
        "l-plugin-2",
        "user-list-2",
        "User 2",
      );

      const { activities, total } = AuditLogging.listUserActivities();

      assert.ok(activities.length >= 2);
      assert.ok(total >= 2);
    });

    it("filters by team", () => {
      AuditLogging.recordAuditEntry(
        "read",
        "plugin",
        "l-plugin-3",
        "user-team-1",
        "User",
        "success",
        {},
        "low",
        "team-a",
      );

      const { activities } = AuditLogging.listUserActivities("team-a");

      assert.ok(activities.length > 0);
    });
  });

  describe("getChangeHistory", () => {
    it("gets change history for resource", () => {
      const resourceId = "res-123";
      AuditLogging.recordChangeHistory(
        resourceId,
        "team",
        "created",
        { name: "New Team" },
        "user-1",
        "User One",
      );
      AuditLogging.recordChangeHistory(
        resourceId,
        "team",
        "updated",
        { name: "Updated Team" },
        "user-2",
        "User Two",
        { name: "New Team" },
      );

      const { history, total } = AuditLogging.getChangeHistory(resourceId);

      assert.equal(total, 2);
      assert.equal(history.length, 2);
      assert.ok(history.every((h) => h.resource_id === resourceId));
    });

    it("respects pagination", () => {
      const resourceId = "res-456";
      for (let i = 0; i < 3; i++) {
        AuditLogging.recordChangeHistory(
          resourceId,
          "member",
          "updated",
          { role: `role-${i}` },
          `user-${i}`,
          `User ${i}`,
        );
      }

      const { history: page1 } = AuditLogging.getChangeHistory(resourceId, 2, 0);
      const { history: page2 } = AuditLogging.getChangeHistory(resourceId, 2, 2);

      assert.equal(page1.length, 2);
      assert.ok(page2.length > 0);
    });
  });

  describe("generateComplianceReport", () => {
    it("generates compliance report", () => {
      const start = new Date();
      start.setDate(start.getDate() - 1);

      AuditLogging.recordAuditEntry(
        "create",
        "team",
        "c-team-1",
        "admin",
        "Admin",
        "success",
      );
      AuditLogging.recordAuditEntry(
        "delete",
        "member",
        "c-member-1",
        "admin",
        "Admin",
        "success",
      );

      // Capture `end` AFTER recording so the report window includes the entries.
      // Capturing before record races on fast CI machines (entries land 1ms past end).
      const end = new Date(Date.now() + 1000);
      const { report } = AuditLogging.generateComplianceReport(
        "SOC2",
        start.toISOString(),
        end.toISOString(),
        "auditor",
      );

      assert.ok(report.id);
      assert.equal(report.standard, "SOC2");
      assert.ok(report.total_audit_entries >= 2);
      assert.ok(report.deletion_events >= 1);
      assert.ok(report.compliance_score >= 0 && report.compliance_score <= 100);
    });

    it("filters by team in report", () => {
      const start = new Date();
      start.setDate(start.getDate() - 1);

      AuditLogging.recordAuditEntry(
        "create",
        "workflow",
        "c-wf-1",
        "user-c",
        "User C",
        "success",
        {},
        "low",
        "team-compliance",
      );

      const end = new Date(Date.now() + 1000);
      const { report } = AuditLogging.generateComplianceReport(
        "GDPR",
        start.toISOString(),
        end.toISOString(),
        "auditor",
        "team-compliance",
      );

      assert.equal(report.team_id, "team-compliance");
      assert.ok(report.total_audit_entries >= 1);
    });

    it("includes critical events as issues", () => {
      const start = new Date();
      start.setDate(start.getDate() - 1);

      AuditLogging.recordAuditEntry(
        "delete",
        "team",
        "c-team-2",
        "admin",
        "Admin",
        "success",
        {},
        "critical",
      );

      const end = new Date(Date.now() + 1000);
      const { report } = AuditLogging.generateComplianceReport(
        "ISO27001",
        start.toISOString(),
        end.toISOString(),
        "auditor",
      );

      assert.ok(report.issues.length > 0);
      assert.ok(report.issues.some((i) => i.severity === "critical"));
    });
  });

  describe("listComplianceReports", () => {
    it("lists compliance reports", () => {
      const start = new Date();
      start.setDate(start.getDate() - 7);
      const end = new Date();

      AuditLogging.generateComplianceReport(
        "SOC2",
        start.toISOString(),
        end.toISOString(),
        "auditor",
      );

      const { reports, total } = AuditLogging.listComplianceReports();

      assert.ok(reports.length >= 1);
      assert.ok(total >= 1);
    });
  });

  describe("requestDataExport", () => {
    it("creates data export request", () => {
      const { request } = AuditLogging.requestDataExport(
        "user-export",
        "json",
        ["team", "member"],
      );

      assert.ok(request.id);
      assert.equal(request.user_id, "user-export");
      assert.equal(request.format, "json");
      assert.equal(request.status, "pending");
    });

    it("handles csv export", () => {
      const { request } = AuditLogging.requestDataExport(
        "user-csv",
        "csv",
        ["plugin", "workflow"],
      );

      assert.equal(request.format, "csv");
      assert.equal(request.data_types.length, 2);
    });

    it("includes date range", () => {
      const start = new Date();
      start.setDate(start.getDate() - 30);

      const { request } = AuditLogging.requestDataExport(
        "user-range",
        "json",
        ["member"],
        undefined,
        start.toISOString(),
        new Date().toISOString(),
      );

      assert.ok(request.start_date);
      assert.ok(request.end_date);
    });
  });

  describe("getDataExportStatus", () => {
    it("gets export status", (t, done) => {
      const { request: initial } = AuditLogging.requestDataExport(
        "user-status",
        "json",
        ["team"],
      );

      // Check immediately (should be pending)
      const { request: check1 } = AuditLogging.getDataExportStatus(initial.id);
      assert.equal(check1?.status, "pending");

      // Wait for simulated processing
      setTimeout(() => {
        const { request: check2 } = AuditLogging.getDataExportStatus(initial.id);
        assert.equal(check2?.status, "completed");
        assert.ok(check2?.download_url);
        assert.ok(check2?.expires_at);
        done();
      }, 1500);
    });
  });

  describe("recordSessionAudit", () => {
    it("records session audit", () => {
      const { session } = AuditLogging.recordSessionAudit(
        "session-user",
        "session-abc123",
        "10.0.0.1",
        "Mozilla/5.0",
      );

      assert.ok(session.id);
      assert.equal(session.user_id, "session-user");
      assert.equal(session.ip_address, "10.0.0.1");
      assert.equal(session.is_active, true);
    });
  });

  describe("endSessionAudit", () => {
    it("ends session audit", () => {
      const { session } = AuditLogging.recordSessionAudit(
        "session-user-2",
        "session-xyz789",
        "10.0.0.2",
        "Chrome/120.0",
      );

      const { success } = AuditLogging.endSessionAudit(session.session_id);

      assert.equal(success, true);
    });

    it("returns error for nonexistent session", () => {
      const { success, error } = AuditLogging.endSessionAudit("nonexistent-session");

      assert.equal(success, false);
      assert.ok(error);
    });
  });

  describe("getAuditMetrics", () => {
    it("returns audit metrics", () => {
      AuditLogging.recordAuditEntry(
        "create",
        "team",
        "m-team-1",
        "metrics-user-1",
        "User 1",
      );
      AuditLogging.recordAuditEntry(
        "update",
        "team",
        "m-team-1",
        "metrics-user-2",
        "User 2",
      );
      AuditLogging.recordAuditEntry(
        "delete",
        "member",
        "m-member-1",
        "metrics-user-1",
        "User 1",
        "failure",
      );

      const metrics = AuditLogging.getAuditMetrics();

      assert.ok(metrics.total_entries >= 3);
      assert.ok(metrics.unique_users >= 2);
      assert.ok(metrics.failed_operations_count >= 1);
      assert.ok(metrics.entries_last_24h >= 3);
      assert.ok(metrics.entries_last_7d >= 3);
      assert.ok(metrics.entries_last_30d >= 3);
    });

    it("identifies most common action", () => {
      for (let i = 0; i < 5; i++) {
        AuditLogging.recordAuditEntry(
          "read",
          "plugin",
          `m-plugin-${i}`,
          `m-user-${i}`,
          `User ${i}`,
        );
      }

      const metrics = AuditLogging.getAuditMetrics();

      assert.ok(metrics.most_common_action);
    });

    it("filters metrics by team", () => {
      AuditLogging.recordAuditEntry(
        "create",
        "team",
        "m-team-2",
        "team-metrics",
        "Team User",
        "success",
        {},
        "low",
        "special-team",
      );

      const metrics = AuditLogging.getAuditMetrics("special-team");

      assert.ok(metrics.total_entries >= 1);
    });
  });

  describe("end-to-end compliance workflow", () => {
    it("tracks operations and generates report", () => {
      const now = new Date();
      const start = new Date(now.getTime() - 2 * 60 * 60 * 1000);

      // Simulate team operations
      AuditLogging.recordAuditEntry(
        "create",
        "team",
        "e2e-team",
        "e2e-owner",
        "Owner",
        "success",
        {},
        "low",
        "e2e-team",
      );

      AuditLogging.recordChangeHistory(
        "e2e-team",
        "team",
        "created",
        { name: "E2E Team", status: "active" },
        "e2e-owner",
        "Owner",
      );

      AuditLogging.recordAuditEntry(
        "update",
        "team",
        "e2e-team",
        "e2e-admin",
        "Admin",
        "success",
        { change: "name" },
        "medium",
        "e2e-team",
      );

      const end = new Date(Date.now() + 1000);
      const { report } = AuditLogging.generateComplianceReport(
        "HIPAA",
        start.toISOString(),
        end.toISOString(),
        "compliance-officer",
        "e2e-team",
      );

      assert.equal(report.team_id, "e2e-team");
      assert.ok(report.total_audit_entries >= 2);
      assert.ok(report.compliance_score > 0);

      const metrics = AuditLogging.getAuditMetrics("e2e-team");
      assert.ok(metrics.total_entries >= 2);
    });
  });
});
