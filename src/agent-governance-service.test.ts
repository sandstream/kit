import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createGovernancePolicy,
  addPolicyRule,
  activatePolicy,
  createSecurityProfile,
  grantPermission,
  revokePermission,
  evaluatePolicy,
  logAuditEvent,
  setRateLimit,
  setResourceQuota,
  getSecurityProfile,
  getAuditLogs,
  getGovernanceMetrics,
  updateTrustScore,
  listPolicies,
} from "./agent-governance-service.js";

describe("agent-governance-service", () => {
  const teamId = "team-governance-123";
  const userId = "user-governance-456";
  const agentId = "agent-gov-789";

  describe("createGovernancePolicy", () => {
    it("creates governance policy", () => {
      const { policy, error } = createGovernancePolicy(
        teamId,
        "Access Control Policy",
        "access_control",
        userId,
        "Control agent access",
      );

      assert.ok(!error);
      assert.ok(policy.id);
      assert.equal(policy.status, "draft");
      assert.equal(policy.enforcement_enabled, false);
    });
  });

  describe("addPolicyRule", () => {
    it("adds rule to policy", () => {
      const { policy } = createGovernancePolicy(teamId, "Policy", "access_control", userId);

      const { policy: updated, error } = addPolicyRule(
        teamId,
        policy.id,
        "agent.risk_level > 'high'",
        "restrict_access",
        "deny",
      );

      assert.ok(!error);
      assert.equal(updated.rules.length, 1);
    });

    it("fails for nonexistent policy", () => {
      const { error } = addPolicyRule(
        teamId,
        "nonexistent-policy",
        "condition",
        "action",
      );

      assert.ok(error);
      assert.equal(error, "Policy not found");
    });
  });

  describe("activatePolicy", () => {
    it("activates policy with rules", () => {
      const { policy } = createGovernancePolicy(teamId, "Policy", "access_control", userId);
      addPolicyRule(teamId, policy.id, "condition", "action");

      const { policy: activated, error } = activatePolicy(teamId, policy.id);

      assert.ok(!error);
      assert.equal(activated.status, "active");
      assert.equal(activated.enforcement_enabled, true);
    });

    it("fails to activate policy without rules", () => {
      const { policy } = createGovernancePolicy(teamId, "Policy", "access_control", userId);

      const { error } = activatePolicy(teamId, policy.id);

      assert.ok(error);
      assert.equal(error, "Policy has no rules");
    });
  });

  describe("createSecurityProfile", () => {
    it("creates security profile", () => {
      const { profile, error } = createSecurityProfile(teamId, agentId, "claude");

      assert.ok(!error);
      assert.ok(profile.id);
      assert.equal(profile.agent_id, agentId);
      assert.equal(profile.risk_level, "medium");
      assert.equal(profile.trust_score, 50);
    });
  });

  describe("grantPermission", () => {
    it("grants permission to agent", () => {
      const { permission, error } = grantPermission(
        teamId,
        agentId,
        "workflow",
        "execute",
        "editor",
        userId,
      );

      assert.ok(!error);
      assert.ok(permission.id);
      assert.equal(permission.agent_id, agentId);
      assert.equal(permission.permission_level, "editor");
    });

    it("grants permission with expiry", () => {
      const expiryDate = new Date();
      expiryDate.setHours(expiryDate.getHours() + 24);

      const { permission } = grantPermission(
        teamId,
        agentId,
        "secret",
        "read",
        "viewer",
        userId,
        undefined,
        expiryDate.toISOString(),
      );

      assert.ok(permission.expires_at);
    });
  });

  describe("revokePermission", () => {
    it("revokes permission", () => {
      const { permission } = grantPermission(
        teamId,
        agentId,
        "workflow",
        "execute",
        "editor",
        userId,
      );

      const { success, error } = revokePermission(teamId, permission.id);

      assert.ok(!error);
      assert.equal(success, true);
    });

    it("fails for nonexistent permission", () => {
      const { error } = revokePermission(teamId, "nonexistent-permission");

      assert.ok(error);
      assert.equal(error, "Permission not found");
    });
  });

  describe("evaluatePolicy", () => {
    it("evaluates policy", () => {
      const { policy } = createGovernancePolicy(teamId, "Policy", "access_control", userId);
      addPolicyRule(teamId, policy.id, "resource == 'workflow'", "execute");
      activatePolicy(teamId, policy.id);

      const { evaluation, error } = evaluatePolicy(
        teamId,
        policy.id,
        agentId,
        "execute",
        "workflow",
      );

      assert.ok(!error);
      assert.ok(evaluation.id);
      assert.equal(evaluation.allowed, true);
    });

    it("fails for inactive policy", () => {
      const { policy } = createGovernancePolicy(teamId, "Policy", "access_control", userId);
      addPolicyRule(teamId, policy.id, "condition", "action");

      const { error } = evaluatePolicy(
        teamId,
        policy.id,
        agentId,
        "execute",
        "workflow",
      );

      assert.ok(error);
      assert.equal(error, "Policy not active");
    });
  });

  describe("logAuditEvent", () => {
    it("logs audit event", () => {
      const { log } = logAuditEvent(teamId, agentId, "allowed", "execute", "workflow", "wf-123");

      assert.ok(log.id);
      assert.equal(log.team_id, teamId);
      assert.equal(log.agent_id, agentId);
      assert.equal(log.status, "allowed");
    });

    it("records critical severity for denied actions", () => {
      const { log } = logAuditEvent(teamId, agentId, "denied", "delete", "secret");

      assert.equal(log.severity, "critical");
    });
  });

  describe("setRateLimit", () => {
    it("sets rate limit for agent", () => {
      const { rateLimit, error } = setRateLimit(teamId, agentId, "api_calls", 60, 1000);

      assert.ok(!error);
      assert.ok(rateLimit.id);
      assert.equal(rateLimit.requests_per_minute, 60);
      assert.equal(rateLimit.enabled, true);
    });

    it("calculates burst limit", () => {
      const { rateLimit } = setRateLimit(teamId, agentId, "api_calls", 100, 6000);

      assert.ok(rateLimit.burst_limit > 100);
    });
  });

  describe("setResourceQuota", () => {
    it("sets resource quota", () => {
      const { quota, error } = setResourceQuota(
        teamId,
        agentId,
        "storage",
        100,
        "gb",
        "month",
      );

      assert.ok(!error);
      assert.ok(quota.id);
      assert.equal(quota.limit, 100);
      assert.equal(quota.unit, "gb");
    });

    it("sets quota without agent id for team-wide limits", () => {
      const { quota } = setResourceQuota(
        teamId,
        undefined,
        "api_calls",
        10000,
        "calls",
        "day",
      );

      assert.ok(!quota.agent_id);
      assert.equal(quota.limit, 10000);
    });
  });

  describe("getSecurityProfile", () => {
    it("gets security profile", () => {
      createSecurityProfile(teamId, agentId, "claude");

      const { profile, error } = getSecurityProfile(teamId, agentId);

      assert.ok(!error);
      assert.ok(profile);
      assert.equal(profile?.agent_id, agentId);
    });

    it("fails for nonexistent profile", () => {
      const { profile, error } = getSecurityProfile(teamId, "nonexistent-agent");

      assert.ok(error);
      assert.ok(!profile);
    });
  });

  describe("getAuditLogs", () => {
    it("gets audit logs", () => {
      const team2 = "team-governance-audit";
      logAuditEvent(team2, agentId, "allowed", "execute", "workflow");
      logAuditEvent(team2, agentId, "denied", "delete", "secret");

      const { logs, total } = getAuditLogs(team2);

      assert.ok(total >= 2);
      assert.ok(logs.length >= 2);
    });

    it("filters by agent id", () => {
      const team3 = "team-governance-filter";
      logAuditEvent(team3, "agent-1", "allowed", "execute", "workflow");
      logAuditEvent(team3, "agent-2", "allowed", "execute", "workflow");

      const { logs } = getAuditLogs(team3, "agent-1");

      assert.ok(logs.every((log) => log.agent_id === "agent-1"));
    });

    it("respects pagination", () => {
      const team4 = "team-governance-pagination";
      for (let i = 0; i < 5; i++) {
        logAuditEvent(team4, agentId, "allowed", "execute", "workflow");
      }

      const page1 = getAuditLogs(team4, undefined, 2, 0);
      const page2 = getAuditLogs(team4, undefined, 2, 2);

      assert.equal(page1.logs.length, 2);
      assert.equal(page2.logs.length, 2);
      assert.notEqual(page1.logs[0]?.id, page2.logs[0]?.id);
    });
  });

  describe("updateTrustScore", () => {
    it("updates trust score", () => {
      createSecurityProfile(teamId, agentId, "claude");

      const { profile } = updateTrustScore(teamId, agentId, 20);

      assert.equal(profile.trust_score, 70);
    });

    it("updates risk level based on trust score", () => {
      createSecurityProfile(teamId, agentId, "claude");
      updateTrustScore(teamId, agentId, 35); // 50 + 35 = 85

      const { profile } = getSecurityProfile(teamId, agentId);

      assert.equal(profile?.risk_level, "low");
    });

    it("clamps trust score between 0 and 100", () => {
      createSecurityProfile(teamId, agentId, "claude");
      updateTrustScore(teamId, agentId, 100);

      const { profile } = updateTrustScore(teamId, agentId, 100);

      assert.equal(profile.trust_score, 100);
    });
  });

  describe("getGovernanceMetrics", () => {
    it("returns governance metrics", () => {
      const team5 = "team-governance-metrics";
      createGovernancePolicy(team5, "Policy 1", "access_control", userId);
      createSecurityProfile(team5, agentId, "claude");

      const metrics = getGovernanceMetrics(team5);

      assert.ok(metrics.total_policies > 0);
      assert.ok(metrics.average_trust_score >= 0);
      assert.ok(metrics.policy_violation_rate_percent >= 0);
    });
  });

  describe("listPolicies", () => {
    it("lists team policies", () => {
      const team6 = "team-governance-list";
      createGovernancePolicy(team6, "Policy 1", "access_control", userId);
      createGovernancePolicy(team6, "Policy 2", "rate_limit", userId);

      const { policies } = listPolicies(team6);

      assert.equal(policies.length, 2);
    });
  });
});
