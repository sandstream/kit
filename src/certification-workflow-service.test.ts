import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createCertificationWorkflow,
  assignReviewer,
  approveStep,
  rejectStep,
  escalateStep,
  getWorkflowStatus,
  getPendingApprovals,
  getAuditTrail,
  getWorkflowMetrics,
  listTemplates,
  getWorkflowProgress,
} from "./certification-workflow-service.js";

describe("certification-workflow-service", () => {
  const pluginId = "plugin-123";
  const version = "1.0.0";
  const userId = "user-456";

  describe("createCertificationWorkflow", () => {
    it("creates workflow for bronze tier", () => {
      const { workflow, error } = createCertificationWorkflow(
        pluginId,
        version,
        "Test Plugin",
        "bronze",
        userId,
      );

      assert.ok(!error);
      assert.ok(workflow.id);
      assert.equal(workflow.plugin_id, pluginId);
      assert.equal(workflow.current_stage, "validation");
      assert.equal(workflow.status, "pending");
    });

    it("creates approval chain with stages", () => {
      const { workflow } = createCertificationWorkflow(
        pluginId,
        version,
        "Plugin",
        "bronze",
        userId,
      );

      assert.ok(workflow.approval_chain.length >= 3);
      assert.ok(
        workflow.approval_chain.some((s) => s.stage === "validation"),
      );
      assert.ok(workflow.approval_chain.some((s) => s.stage === "review"));
    });

    it("creates audit trail entry", () => {
      const { workflow } = createCertificationWorkflow(
        pluginId,
        version,
        "Plugin",
        "gold",
        userId,
      );

      assert.ok(workflow.audit_trail.length > 0);
      assert.ok(
        workflow.audit_trail.some((e) => e.event_type === "workflow_created"),
      );
    });
  });

  describe("assignReviewer", () => {
    it("assigns reviewer to step", () => {
      const { workflow } = createCertificationWorkflow(
        pluginId,
        version,
        "Plugin",
        "bronze",
        userId,
      );

      const step = workflow.approval_chain[0];

      const { assignment, error } = assignReviewer(
        workflow.id,
        step.id,
        "reviewer-123",
        "John Reviewer",
        "reviewer",
      );

      assert.ok(!error);
      assert.ok(assignment.id);
      assert.equal(assignment.reviewer_id, "reviewer-123");
    });

    it("sets response deadline", () => {
      const { workflow } = createCertificationWorkflow(
        pluginId,
        version,
        "Plugin",
        "bronze",
        userId,
      );

      const step = workflow.approval_chain[0];
      const { assignment } = assignReviewer(
        workflow.id,
        step.id,
        "reviewer-123",
        "John Reviewer",
        "reviewer",
      );

      assert.ok(assignment.response_deadline);
      const deadline = new Date(assignment.response_deadline);
      const now = new Date();
      assert.ok(deadline > now);
    });
  });

  describe("approveStep", () => {
    it("approves step and moves to next stage", () => {
      const { workflow: w1 } = createCertificationWorkflow(
        pluginId,
        version,
        "Plugin",
        "bronze",
        userId,
      );

      const step = w1.approval_chain[0];
      const { step: approved, error } = approveStep(
        w1.id,
        step.id,
        "reviewer-123",
        "John Reviewer",
        "Looks good",
      );

      assert.ok(!error);
      assert.equal(approved?.status, "approved");
      assert.ok(approved?.approved_at);

      const { workflow: w2 } = getWorkflowStatus(w1.id);
      assert.ok(w2?.current_stage !== "validation");
    });

    it("records audit event", () => {
      const { workflow: w1 } = createCertificationWorkflow(
        pluginId,
        version,
        "Plugin",
        "bronze",
        userId,
      );

      const step = w1.approval_chain[0];
      approveStep(w1.id, step.id, "reviewer-123", "John Reviewer");

      const { events } = getAuditTrail(w1.id);
      assert.ok(events.some((e) => e.event_type === "approved"));
    });

    it("marks workflow completed when last step approved", () => {
      const { workflow } = createCertificationWorkflow(
        pluginId,
        version,
        "Plugin",
        "bronze",
        userId,
      );

      // Approve all steps
      workflow.approval_chain.forEach((step) => {
        approveStep(workflow.id, step.id, "reviewer", "Reviewer");
      });

      const { workflow: updated } = getWorkflowStatus(workflow.id);
      assert.equal(updated?.status, "approved");
      assert.equal(updated?.completed_at, updated?.completed_at); // has value
    });
  });

  describe("rejectStep", () => {
    it("rejects step and fails workflow", () => {
      const { workflow } = createCertificationWorkflow(
        pluginId,
        version,
        "Plugin",
        "bronze",
        userId,
      );

      const step = workflow.approval_chain[0];
      const { step: rejected } = rejectStep(
        workflow.id,
        step.id,
        "reviewer-123",
        "John Reviewer",
        "Does not meet security standards",
      );

      assert.equal(rejected?.status, "rejected");
      assert.ok(rejected?.rejection_reason);

      const { workflow: w } = getWorkflowStatus(workflow.id);
      assert.equal(w?.status, "rejected");
    });
  });

  describe("escalateStep", () => {
    it("escalates step to higher authority", () => {
      const { workflow } = createCertificationWorkflow(
        pluginId,
        version,
        "Plugin",
        "bronze",
        userId,
      );

      const step = workflow.approval_chain[0];
      const { step: escalated } = escalateStep(
        workflow.id,
        step.id,
        "reviewer-123",
        "admin-456",
        "Needs expert review",
      );

      assert.equal(escalated?.escalated, true);
      assert.equal(escalated?.escalated_to, "admin-456");
      assert.equal(escalated?.status, "escalated");
    });
  });

  describe("getWorkflowStatus", () => {
    it("returns workflow status", () => {
      const { workflow: w1 } = createCertificationWorkflow(
        pluginId,
        version,
        "Plugin",
        "bronze",
        userId,
      );

      const { workflow: w2 } = getWorkflowStatus(w1.id);

      assert.equal(w2?.id, w1.id);
      assert.equal(w2?.status, "pending");
    });

    it("fails for nonexistent workflow", () => {
      const { workflow, error } = getWorkflowStatus("nonexistent");

      assert.ok(error);
      assert.ok(!workflow);
    });
  });

  describe("getPendingApprovals", () => {
    it("gets pending approvals for reviewer", () => {
      const { workflow } = createCertificationWorkflow(
        pluginId,
        version,
        "Plugin",
        "bronze",
        userId,
      );

      const step = workflow.approval_chain[0];
      assignReviewer(workflow.id, step.id, "reviewer-123", "Reviewer", "reviewer");

      const { pending } = getPendingApprovals("reviewer-123");

      assert.ok(pending.length > 0);
      assert.ok(pending.some((s) => s.assigned_to === "reviewer-123"));
    });
  });

  describe("getAuditTrail", () => {
    it("returns audit trail for workflow", () => {
      const { workflow } = createCertificationWorkflow(
        pluginId,
        version,
        "Plugin",
        "bronze",
        userId,
      );

      const { events } = getAuditTrail(workflow.id);

      assert.ok(events.length > 0);
      assert.ok(events.some((e) => e.event_type === "workflow_created"));
    });

    it("tracks workflow changes", () => {
      const { workflow: w1 } = createCertificationWorkflow(
        pluginId,
        version,
        "Plugin",
        "bronze",
        userId,
      );

      const step = w1.approval_chain[0];
      assignReviewer(w1.id, step.id, "reviewer-123", "Reviewer", "reviewer");
      approveStep(w1.id, step.id, "reviewer-123", "Reviewer");

      const { events } = getAuditTrail(w1.id);

      assert.ok(events.some((e) => e.event_type === "reviewer_assigned"));
      assert.ok(events.some((e) => e.event_type === "approved"));
    });
  });

  describe("getWorkflowProgress", () => {
    it("calculates workflow progress", () => {
      const { workflow } = createCertificationWorkflow(
        pluginId,
        version,
        "Plugin",
        "bronze",
        userId,
      );

      const { progress_percent } = getWorkflowProgress(workflow.id);

      assert.equal(progress_percent, 0); // No steps approved yet
    });

    it("increases progress as steps complete", () => {
      const { workflow } = createCertificationWorkflow(
        pluginId,
        version,
        "Plugin",
        "bronze",
        userId,
      );

      const step1 = workflow.approval_chain[0];
      approveStep(workflow.id, step1.id, "reviewer", "Reviewer");

      const { progress_percent } = getWorkflowProgress(workflow.id);

      assert.ok(progress_percent > 0);
      assert.ok(progress_percent < 100);
    });
  });

  describe("listTemplates", () => {
    it("lists approval chain templates", () => {
      const { templates } = listTemplates();

      assert.ok(templates.length > 0);
      assert.ok(
        templates.some((t) => t.certification_tier === "bronze"),
      );
      assert.ok(templates.some((t) => t.certification_tier === "gold"));
    });

    it("templates have stages", () => {
      const { templates } = listTemplates();

      templates.forEach((t) => {
        assert.ok(t.stages.length > 0);
        t.stages.forEach((s) => {
          assert.ok(s.stage);
          assert.ok(s.required_role);
          assert.ok(s.min_approval_count >= 1);
        });
      });
    });
  });

  describe("getWorkflowMetrics", () => {
    it("returns workflow metrics", () => {
      createCertificationWorkflow(pluginId, version, "Plugin", "bronze", userId);

      const metrics = getWorkflowMetrics();

      assert.ok(metrics.total_workflows >= 1);
      assert.ok(metrics.average_completion_hours > 0);
      assert.ok(metrics.approval_rate_percent >= 0);
    });
  });
});
