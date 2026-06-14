import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createApprovalPolicy,
  requestChangeApproval,
  respondToApprovalRequest,
  getApprovalMetrics,
  getGovernanceLogs,
} from "./approval-service.js";

describe("approval-service", () => {
  const teamId = "team-test-123";
  const ownerId = "owner-456";
  const adminId = "admin-789";

  describe("createApprovalPolicy", () => {
    it("creates approval policy", () => {
      const { policy, error } = createApprovalPolicy(
        teamId,
        "config_change",
        2,
        ["owner", "admin"],
      );

      assert.ok(!error);
      assert.ok(policy.id);
      assert.equal(policy.required_approvers, 2);
      assert.deepEqual(policy.allowed_approver_roles, ["owner", "admin"]);
    });

    it("rejects invalid approver count", () => {
      const { error } = createApprovalPolicy(teamId, "secret_access", 0);

      assert.ok(error);
      assert.equal(error, "At least 1 approver required");
    });
  });

  describe("requestChangeApproval", () => {
    it("creates change request requiring approval", () => {
      const { request, error } = requestChangeApproval(
        teamId,
        "config_change",
        ownerId,
        "owner@kit.local",
        "database",
        "db-123",
        "PostgreSQL DB",
        "Upgrade version",
        { version: "15.0" },
      );

      assert.ok(!error);
      assert.ok(request.id);
      assert.equal(request.status, "pending");
      assert.ok(request.required_approvals >= 1);
    });
  });

  describe("respondToApprovalRequest", () => {
    it("approves change request", () => {
      const { request } = requestChangeApproval(
        teamId,
        "config_change",
        ownerId,
        "owner@kit.local",
        "service",
        "svc-123",
        "Stripe",
        "Add integration",
        { service: "stripe" },
      );

      const { approval, error } = respondToApprovalRequest(
        request.id,
        adminId,
        "admin@kit.local",
        "approve",
        "Looks good",
      );

      assert.ok(!error);
      assert.ok(approval.id);
      assert.equal(approval.decision, "approve");
      assert.equal(approval.comment, "Looks good");
    });

    it("rejects change request", () => {
      const { request } = requestChangeApproval(
        teamId,
        "secret_access",
        ownerId,
        "owner@kit.local",
        "secret",
        "secret-123",
        "API_KEY",
        "Access production secret",
        {},
      );

      const { approval, error } = respondToApprovalRequest(
        request.id,
        adminId,
        "admin@kit.local",
        "reject",
        "Not authorized for prod access",
      );

      assert.ok(!error);
      assert.equal(approval.decision, "reject");
      assert.equal(approval.status, "rejected");
    });

    it("returns error for missing request", () => {
      const { error } = respondToApprovalRequest(
        "nonexistent-123",
        adminId,
        "admin@kit.local",
        "approve",
      );

      assert.ok(error);
      assert.equal(error, "Change request not found");
    });
  });

  describe("getApprovalMetrics", () => {
    it("calculates approval metrics", () => {
      const metricsTeamId = "team-metrics-456";

      // Create and approve a change
      const { request } = requestChangeApproval(
        metricsTeamId,
        "config_change",
        ownerId,
        "owner@kit.local",
        "tool",
        "tool-123",
        "Node",
        "Update to v22",
        { version: "22.0.0" },
      );

      respondToApprovalRequest(
        request.id,
        adminId,
        "admin@kit.local",
        "approve",
      );

      const metrics = getApprovalMetrics(metricsTeamId);

      assert.equal(metrics.total_approved, 1);
      assert.ok(metrics.approval_rate_percent >= 0);
    });
  });

  describe("getGovernanceLogs", () => {
    it("returns governance events", () => {
      requestChangeApproval(
        teamId,
        "service_integration",
        ownerId,
        "owner@kit.local",
        "service",
        "github-123",
        "GitHub",
        "Add org integration",
        { organization: "kit-org" },
      );

      const { logs, total } = getGovernanceLogs(teamId);

      // Position-independent: the governance log is a process-global singleton shared
      // across concurrently-run test files, so assert the event exists rather than [0].
      assert.ok(total >= 1);
      assert.ok(logs.some((l) => l.event_type === "change_requested"));
    });
  });
});
