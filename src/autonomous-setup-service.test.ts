import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  detectProjectStack,
  initiateSetupWorkflow,
  executeSetupStep,
  approveSetupStep,
  requestSetupDecision,
  recordSetupDecision,
  applySetupPreset,
  verifySetupCompletion,
  getWorkflowStatus,
  getSetupMetrics,
  listAvailablePresets,
} from "./autonomous-setup-service.js";

describe("autonomous-setup-service", () => {
  const teamId = "team-setup-123";
  const userId = "user-setup-456";
  const projectPath = "/home/user/my-project";

  describe("detectProjectStack", () => {
    it("detects project stack", () => {
      const { detection, error } = detectProjectStack(projectPath);

      assert.ok(!error);
      assert.ok(detection.id);
      assert.equal(detection.project_path, projectPath);
      assert.ok(detection.detected_type);
      assert.ok(detection.confidence >= 0 && detection.confidence <= 100);
      assert.ok(detection.detected_tools.length > 0);
    });
  });

  describe("initiateSetupWorkflow", () => {
    it("initiates setup workflow", () => {
      const { workflow, error } = initiateSetupWorkflow(
        teamId,
        "proj-123",
        projectPath,
        "nodejs",
        "autonomous",
        userId,
      );

      assert.ok(!error);
      assert.ok(workflow.id);
      assert.equal(workflow.team_id, teamId);
      assert.equal(workflow.project_type, "nodejs");
      assert.equal(workflow.current_phase, "detection");
      assert.equal(workflow.status, "pending");
      assert.ok(workflow.steps.length > 0);
    });
  });

  describe("executeSetupStep", () => {
    it("executes setup step", () => {
      const { workflow } = initiateSetupWorkflow(
        teamId,
        "proj-123",
        projectPath,
        "nodejs",
        "autonomous",
        userId,
      );

      const detectStep = workflow.steps.find((s) => s.category === "detect")!;

      const { step, error } = executeSetupStep(teamId, workflow.id, detectStep.id);

      assert.ok(!error);
      assert.equal(step.status, "completed");
      assert.ok(step.executed_at);
      assert.ok(step.duration_ms !== undefined);
    });

    it("fails for step requiring approval", () => {
      const { workflow } = initiateSetupWorkflow(
        teamId,
        "proj-456",
        projectPath,
        "nodejs",
        "autonomous",
        userId,
      );

      const configStep = workflow.steps.find((s) => s.category === "configure")!;

      const { error } = executeSetupStep(teamId, workflow.id, configStep.id);

      assert.ok(error);
      assert.ok(error?.includes("approval"));
    });

    it("fails for nonexistent workflow", () => {
      const { error } = executeSetupStep(teamId, "nonexistent-workflow", "step-123");

      assert.ok(error);
      assert.equal(error, "Workflow not found");
    });
  });

  describe("approveSetupStep", () => {
    it("approves setup step", () => {
      const { workflow } = initiateSetupWorkflow(
        teamId,
        "proj-789",
        projectPath,
        "nodejs",
        "guided",
        userId,
      );

      const configStep = workflow.steps.find((s) => s.category === "configure")!;

      const { step, error } = approveSetupStep(teamId, workflow.id, configStep.id, userId);

      assert.ok(!error);
      assert.equal(step.approved_by, userId);
      assert.ok(step.approved_at);
    });

    it("fails for nonexistent step", () => {
      const { workflow } = initiateSetupWorkflow(
        teamId,
        "proj-111",
        projectPath,
        "python",
        "autonomous",
        userId,
      );

      const { error } = approveSetupStep(teamId, workflow.id, "nonexistent-step", userId);

      assert.ok(error);
      assert.equal(error, "Step not found");
    });
  });

  describe("requestSetupDecision", () => {
    it("creates setup decision", () => {
      const { workflow } = initiateSetupWorkflow(
        teamId,
        "proj-222",
        projectPath,
        "nodejs",
        "guided",
        userId,
      );

      const detectStep = workflow.steps[0];

      const { decision, error } = requestSetupDecision(
        teamId,
        workflow.id,
        detectStep.id,
        "tool_selection",
        "Which package manager?",
        ["npm", "yarn", "pnpm"],
        "npm recommended",
      );

      assert.ok(!error);
      assert.ok(decision.id);
      assert.equal(decision.decision_type, "tool_selection");
      assert.equal(decision.options.length, 3);
    });
  });

  describe("recordSetupDecision", () => {
    it("records user decision", () => {
      const { workflow } = initiateSetupWorkflow(
        teamId,
        "proj-333",
        projectPath,
        "nodejs",
        "guided",
        userId,
      );

      const detectStep = workflow.steps[0];

      const { decision: created } = requestSetupDecision(
        teamId,
        workflow.id,
        detectStep.id,
        "framework",
        "Which framework?",
        ["next.js", "remix", "nuxt"],
      );

      const { decision, error } = recordSetupDecision(
        teamId,
        created.id,
        "next.js",
        userId,
        "Best for startup projects",
      );

      assert.ok(!error);
      assert.equal(decision.selected_option, "next.js");
      assert.equal(decision.selected_by, userId);
      assert.ok(decision.selected_at);
    });

    it("fails for nonexistent decision", () => {
      const { error } = recordSetupDecision(
        teamId,
        "nonexistent-decision",
        "option",
        userId,
      );

      assert.ok(error);
      assert.equal(error, "Decision not found");
    });
  });

  describe("applySetupPreset", () => {
    it("applies preset to workflow", () => {
      const { workflow } = initiateSetupWorkflow(
        teamId,
        "proj-444",
        projectPath,
        "nodejs",
        "autonomous",
        userId,
      );

      const { workflow: updated, error } = applySetupPreset(
        teamId,
        workflow.id,
        "Next.js + PostgreSQL",
      );

      assert.ok(!error);
      assert.ok(updated.steps.some((s) => s.status === "completed"));
    });

    it("fails for nonexistent preset", () => {
      const { workflow } = initiateSetupWorkflow(
        teamId,
        "proj-555",
        projectPath,
        "nodejs",
        "autonomous",
        userId,
      );

      const { error } = applySetupPreset(
        teamId,
        workflow.id,
        "Nonexistent Preset",
      );

      assert.ok(error);
      assert.equal(error, "Preset not found");
    });
  });

  describe("verifySetupCompletion", () => {
    it("verifies setup completion", () => {
      const { workflow } = initiateSetupWorkflow(
        teamId,
        "proj-666",
        projectPath,
        "nodejs",
        "autonomous",
        userId,
      );

      const { verification, error } = verifySetupCompletion(
        teamId,
        workflow.id,
        "tools",
      );

      assert.ok(!error);
      assert.ok(verification.checks.length > 0);
      assert.ok(["passed", "warning", "failed"].includes(verification.status));
    });
  });

  describe("getWorkflowStatus", () => {
    it("returns workflow status", () => {
      const { workflow: created } = initiateSetupWorkflow(
        teamId,
        "proj-777",
        projectPath,
        "nodejs",
        "autonomous",
        userId,
      );

      const { workflow, error } = getWorkflowStatus(teamId, created.id);

      assert.ok(!error);
      assert.equal(workflow?.id, created.id);
      assert.equal(workflow?.status, "pending");
    });

    it("fails for nonexistent workflow", () => {
      const { workflow, error } = getWorkflowStatus(teamId, "nonexistent");

      assert.ok(error);
      assert.equal(error, "Workflow not found");
      assert.ok(!workflow);
    });
  });

  describe("getSetupMetrics", () => {
    it("returns setup metrics", () => {
      const team2 = "team-metrics-2";

      initiateSetupWorkflow(team2, "proj-a", projectPath, "nodejs", "autonomous", userId);
      initiateSetupWorkflow(team2, "proj-b", projectPath, "python", "guided", userId);

      const metrics = getSetupMetrics(team2);

      assert.equal(metrics.total_workflows, 2);
      assert.ok(metrics.success_rate_percent >= 0);
      assert.ok(metrics.autonomous_success_rate >= 0);
      assert.ok(metrics.guided_success_rate >= 0);
    });
  });

  describe("listAvailablePresets", () => {
    it("lists available presets", () => {
      const { presets } = listAvailablePresets();

      assert.ok(presets.length > 0);
      assert.ok(presets.some((p) => p.preset_name.includes("Next.js")));
      assert.ok(presets.some((p) => p.preset_name.includes("FastAPI")));
    });
  });
});
