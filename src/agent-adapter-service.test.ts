import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  registerAgentAdapter,
  getAdapterStatus,
  checkCapabilities,
  toggleCapability,
  introspectAgent,
  createAutomation,
  setupCollaboration,
  getAdapterMetrics,
  listTeamAdapters,
  getCollaborationStatus,
} from "./agent-adapter-service.js";

describe("agent-adapter-service", () => {
  const teamId = "team-agents-123";

  describe("registerAgentAdapter", () => {
    it("registers Claude adapter", () => {
      const { adapter, error } = registerAgentAdapter(teamId, "claude", {
        api_key: "sk-test123",
        model: "claude-4-opus",
      });

      assert.ok(!error);
      assert.equal(adapter.agent_type, "claude");
      assert.equal(adapter.status, "installed");
      assert.ok(adapter.enabled_capabilities.includes("file_read"));
    });

    it("registers Cursor adapter", () => {
      const { adapter, error } = registerAgentAdapter(teamId, "cursor", {
        editor_path: "/usr/local/bin/cursor",
        project_root: "/home/user/project",
      });

      assert.ok(!error);
      assert.equal(adapter.agent_type, "cursor");
      assert.ok(adapter.enabled_capabilities.includes("workspace_awareness"));
    });

    it("registers Cline adapter", () => {
      const { adapter, error } = registerAgentAdapter(teamId, "cline", {
        agent_key: "key-cline-123",
      });

      assert.ok(!error);
      assert.equal(adapter.agent_type, "cline");
      assert.ok(adapter.enabled_capabilities.includes("terminal_access"));
    });

    it("fails without required config", () => {
      const { error } = registerAgentAdapter(teamId, "claude", {});

      assert.ok(error);
      assert.ok(error?.includes("required config"));
    });

    it("fails for unknown agent type", () => {
      const { error } = registerAgentAdapter(teamId, "unknown" as any, {
        config: "value",
      });

      assert.ok(error);
    });
  });

  describe("getAdapterStatus", () => {
    it("returns adapter status", () => {
      const { adapter: created } = registerAgentAdapter(teamId, "claude", {
        api_key: "sk-test",
      });

      const { adapter, error } = getAdapterStatus(teamId, created.id);

      assert.ok(!error);
      assert.equal(adapter?.status, "installed");
      assert.equal(adapter?.health_status, "healthy");
    });

    it("fails for nonexistent adapter", () => {
      const { error } = getAdapterStatus(teamId, "nonexistent");

      assert.ok(error);
      assert.equal(error, "Adapter not found");
    });
  });

  describe("checkCapabilities", () => {
    it("returns adapter capabilities", () => {
      const { adapter: created } = registerAgentAdapter(teamId, "cursor", {
        editor_path: "/usr/bin/cursor",
        project_root: "/home/user/project",
      });

      const { capabilities, coverage_percent } = checkCapabilities(teamId, created.id);

      assert.ok(capabilities.length > 0);
      assert.equal(coverage_percent, 100);
      assert.ok(capabilities.every((c) => c.enabled));
    });
  });

  describe("toggleCapability", () => {
    it("disables capability", () => {
      const { adapter: created } = registerAgentAdapter(teamId, "claude", {
        api_key: "sk-test",
      });

      const { capabilities } = checkCapabilities(teamId, created.id);
      const testCap = capabilities[0];

      const { capability, error } = toggleCapability(teamId, testCap.id, false);

      assert.ok(!error);
      assert.ok(!capability.enabled);
    });

    it("fails for nonexistent capability", () => {
      const { error } = toggleCapability(teamId, "nonexistent-cap", false);

      assert.ok(error);
      assert.equal(error, "Capability not found");
    });
  });

  describe("introspectAgent", () => {
    it("introspects agent state", () => {
      const { adapter: created } = registerAgentAdapter(teamId, "claude", {
        api_key: "sk-test",
      });

      const { introspection, error } = introspectAgent(teamId, created.id, "capabilities");

      assert.ok(!error);
      assert.equal(introspection.introspection_type, "capabilities");
      assert.ok(introspection.data);
      assert.equal(introspection.data.agent_type, "claude");
    });

    it("fails for nonexistent adapter", () => {
      const { error } = introspectAgent(teamId, "nonexistent", "health");

      assert.ok(error);
      assert.equal(error, "Adapter not found");
    });
  });

  describe("createAutomation", () => {
    it("creates automation for adapter", () => {
      const { adapter: created } = registerAgentAdapter(teamId, "cline", {
        agent_key: "key-123",
      });

      const { automation, error } = createAutomation(
        teamId,
        created.id,
        "run_tests",
        "on_file_change",
        ["npm test", "npm run lint"],
      );

      assert.ok(!error);
      assert.equal(automation.automation_name, "run_tests");
      assert.equal(automation.trigger, "on_file_change");
      assert.ok(automation.enabled);
    });

    it("fails for nonexistent adapter", () => {
      const { error } = createAutomation(
        teamId,
        "nonexistent",
        "auto",
        "trigger",
        ["action"],
      );

      assert.ok(error);
      assert.equal(error, "Adapter not found");
    });
  });

  describe("setupCollaboration", () => {
    it("sets up multi-agent collaboration", () => {
      const team2 = "team-collab-2";

      const { adapter: claude } = registerAgentAdapter(team2, "claude", {
        api_key: "sk-test",
      });
      const { adapter: cursor } = registerAgentAdapter(team2, "cursor", {
        editor_path: "/usr/bin/cursor",
        project_root: "/home/user/project",
      });

      const { collaboration, error } = setupCollaboration(
        team2,
        [claude.id, cursor.id],
        "sequential",
        { shared_state: "initial" },
      );

      assert.ok(!error);
      assert.equal(collaboration.agents.length, 2);
      assert.equal(collaboration.mode, "sequential");
      assert.equal(collaboration.status, "active");
      assert.equal(collaboration.agents[0].role, "primary");
    });

    it("fails with missing adapters", () => {
      const { error } = setupCollaboration(
        teamId,
        ["nonexistent1", "nonexistent2"],
        "parallel",
      );

      assert.ok(error);
      assert.ok(error?.includes("not found"));
    });
  });

  describe("getAdapterMetrics", () => {
    it("returns adapter metrics", () => {
      const team3 = "team-metrics-3";

      const { adapter: created } = registerAgentAdapter(team3, "claude", {
        api_key: "sk-test",
      });

      const metrics = getAdapterMetrics(team3, created.id);

      assert.equal(metrics.adapter_id, created.id);
      assert.equal(metrics.agent_type, "claude");
      assert.ok(metrics.health_score > 0);
      assert.ok(metrics.uptime_percent > 0);
      assert.ok(metrics.capability_coverage >= 0);
    });
  });

  describe("listTeamAdapters", () => {
    it("lists all team adapters", () => {
      const team4 = "team-list-4";

      registerAgentAdapter(team4, "claude", { api_key: "sk-test" });
      registerAgentAdapter(team4, "cursor", {
        editor_path: "/usr/bin/cursor",
        project_root: "/home/user/project",
      });

      const { adapters } = listTeamAdapters(team4);

      assert.equal(adapters.length, 2);
      assert.ok(adapters.some((a) => a.agent_type === "claude"));
      assert.ok(adapters.some((a) => a.agent_type === "cursor"));
    });
  });

  describe("getCollaborationStatus", () => {
    it("returns collaboration status", () => {
      const team5 = "team-status-5";

      const { adapter: a1 } = registerAgentAdapter(team5, "claude", {
        api_key: "sk-test",
      });
      const { adapter: a2 } = registerAgentAdapter(team5, "cline", {
        agent_key: "key-123",
      });

      const { collaboration: created } = setupCollaboration(
        team5,
        [a1.id, a2.id],
        "hierarchical",
      );

      const { collaboration, error } = getCollaborationStatus(team5, created.id);

      assert.ok(!error);
      assert.equal(collaboration?.status, "active");
      assert.equal(collaboration?.mode, "hierarchical");
    });

    it("fails for nonexistent collaboration", () => {
      const { error } = getCollaborationStatus(teamId, "nonexistent");

      assert.ok(error);
      assert.equal(error, "Collaboration not found");
    });
  });
});
