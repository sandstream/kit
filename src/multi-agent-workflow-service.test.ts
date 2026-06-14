import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createWorkflow,
  addWorkflowTask,
  assignAgentToTask,
  setupCoordination,
  executeWorkflow,
  completeTask,
  failTask,
  getWorkflowStatus,
  getTaskStatus,
  pauseWorkflow,
  resumeWorkflow,
  cancelWorkflow,
  createWorkflowFromTemplate,
  listWorkflowTemplates,
  getWorkflowMetrics,
} from "./multi-agent-workflow-service.js";

describe("multi-agent-workflow-service", () => {
  const teamId = "team-workflow-123";
  const userId = "user-workflow-456";

  describe("createWorkflow", () => {
    it("creates new workflow", () => {
      const { workflow, error } = createWorkflow(
        teamId,
        "Test Workflow",
        userId,
        "A test workflow",
      );

      assert.ok(!error);
      assert.ok(workflow.id);
      assert.equal(workflow.team_id, teamId);
      assert.equal(workflow.workflow_name, "Test Workflow");
      assert.equal(workflow.status, "draft");
      assert.ok(workflow.created_at);
    });
  });

  describe("addWorkflowTask", () => {
    it("adds task to workflow", () => {
      const { workflow } = createWorkflow(teamId, "Workflow", userId);

      const { task, error } = addWorkflowTask(
        teamId,
        workflow.id,
        "Task 1",
        "First task",
        1,
      );

      assert.ok(!error);
      assert.ok(task.id);
      assert.equal(task.workflow_id, workflow.id);
      assert.equal(task.status, "pending");
    });

    it("fails for nonexistent workflow", () => {
      const { error } = addWorkflowTask(
        teamId,
        "nonexistent-workflow",
        "Task",
        "Description",
        1,
      );

      assert.ok(error);
      assert.equal(error, "Workflow not found");
    });

    it("adds task with dependencies", () => {
      const { workflow } = createWorkflow(teamId, "Workflow", userId);
      const { task: task1 } = addWorkflowTask(teamId, workflow.id, "Task 1", "First", 1);
      const { task: task2 } = addWorkflowTask(
        teamId,
        workflow.id,
        "Task 2",
        "Second",
        2,
        [task1.id],
      );

      assert.deepEqual(task2.dependencies, [task1.id]);
    });
  });

  describe("assignAgentToTask", () => {
    it("assigns agent to task", () => {
      const { workflow } = createWorkflow(teamId, "Workflow", userId);
      const { task: workflowTask } = addWorkflowTask(
        teamId,
        workflow.id,
        "Task",
        "Description",
        1,
      );

      const { task, error } = assignAgentToTask(
        teamId,
        workflow.id,
        workflowTask.id,
        "agent-123",
        "claude",
      );

      assert.ok(!error);
      assert.equal(task.assigned_agent_id, "agent-123");
      assert.equal(task.assigned_agent_type, "claude");
      assert.equal(task.status, "assigned");
    });

    it("adds agent to workflow", () => {
      const { workflow } = createWorkflow(teamId, "Workflow", userId);
      const { task: workflowTask } = addWorkflowTask(
        teamId,
        workflow.id,
        "Task",
        "Description",
        1,
      );

      assignAgentToTask(teamId, workflow.id, workflowTask.id, "agent-123", "claude");

      const { workflow: updated } = getWorkflowStatus(teamId, workflow.id);
      assert.ok(updated?.agents.some((a) => a.agent_id === "agent-123"));
    });
  });

  describe("setupCoordination", () => {
    it("sets up sequential coordination", () => {
      const { workflow } = createWorkflow(teamId, "Workflow", userId);
      const { task: task1 } = addWorkflowTask(teamId, workflow.id, "Task 1", "First", 1);
      const { task: task2 } = addWorkflowTask(teamId, workflow.id, "Task 2", "Second", 2);

      const { coordination, error } = setupCoordination(
        teamId,
        workflow.id,
        "sequential",
        [task1.id, task2.id],
      );

      assert.ok(!error);
      assert.equal(coordination.coordination_type, "sequential");
      assert.deepEqual(coordination.sequential_tasks, [task1.id, task2.id]);
    });

    it("sets up parallel coordination", () => {
      const { workflow } = createWorkflow(teamId, "Workflow", userId);
      const { task: task1 } = addWorkflowTask(teamId, workflow.id, "Task 1", "First", 1);
      const { task: task2 } = addWorkflowTask(teamId, workflow.id, "Task 2", "Second", 1);

      const { coordination } = setupCoordination(
        teamId,
        workflow.id,
        "parallel",
        [task1.id, task2.id],
      );

      assert.equal(coordination.coordination_type, "parallel");
      assert.deepEqual(coordination.parallel_tasks, [task1.id, task2.id]);
    });
  });

  describe("executeWorkflow", () => {
    it("executes workflow and starts root tasks", () => {
      const { workflow } = createWorkflow(teamId, "Workflow", userId);
      addWorkflowTask(teamId, workflow.id, "Task 1", "First", 1);

      const { execution, error } = executeWorkflow(teamId, workflow.id);

      assert.ok(!error);
      assert.ok(execution.id);
      assert.equal(execution.execution_status, "active");
      assert.ok(execution.started_at);
    });

    it("fails for workflow with no tasks", () => {
      const { workflow } = createWorkflow(teamId, "Workflow", userId);

      const { error } = executeWorkflow(teamId, workflow.id);

      assert.ok(error);
      assert.equal(error, "Workflow has no tasks");
    });

    it("passes input data to workflow", () => {
      const { workflow } = createWorkflow(teamId, "Workflow", userId);
      addWorkflowTask(teamId, workflow.id, "Task", "Desc", 1);
      const input = { param1: "value1" };

      executeWorkflow(teamId, workflow.id, input);

      const { workflow: updated } = getWorkflowStatus(teamId, workflow.id);
      assert.deepEqual(updated?.input_data, input);
    });
  });

  describe("completeTask", () => {
    it("completes task", () => {
      const { workflow } = createWorkflow(teamId, "Workflow", userId);
      const { task: task1 } = addWorkflowTask(teamId, workflow.id, "Task", "Desc", 1);

      const { task, error } = completeTask(teamId, workflow.id, task1.id);

      assert.ok(!error);
      assert.equal(task.status, "completed");
      assert.ok(task.completed_at);
    });

    it("unlocks dependent tasks", () => {
      const { workflow } = createWorkflow(teamId, "Workflow", userId);
      const { task: task1 } = addWorkflowTask(teamId, workflow.id, "Task 1", "First", 1);
      const { task: task2 } = addWorkflowTask(
        teamId,
        workflow.id,
        "Task 2",
        "Second",
        2,
        [task1.id],
      );

      executeWorkflow(teamId, workflow.id);
      completeTask(teamId, workflow.id, task1.id);

      const { task } = getTaskStatus(teamId, workflow.id, task2.id);
      assert.equal(task?.status, "in_progress");
    });

    it("marks workflow complete when all tasks done", () => {
      const { workflow } = createWorkflow(teamId, "Workflow", userId);
      const { task: task1 } = addWorkflowTask(teamId, workflow.id, "Task", "Desc", 1);

      executeWorkflow(teamId, workflow.id);
      completeTask(teamId, workflow.id, task1.id);

      const { workflow: updated } = getWorkflowStatus(teamId, workflow.id);
      assert.equal(updated?.status, "completed");
    });

    it("stores output data", () => {
      const { workflow } = createWorkflow(teamId, "Workflow", userId);
      const { task: task1 } = addWorkflowTask(teamId, workflow.id, "Task", "Desc", 1);
      const output = { result: "success" };

      completeTask(teamId, workflow.id, task1.id, output);

      const { task } = getTaskStatus(teamId, workflow.id, task1.id);
      assert.deepEqual(task?.output_data, output);
    });
  });

  describe("failTask", () => {
    it("fails task after max retries", () => {
      const { workflow } = createWorkflow(teamId, "Workflow", userId);
      const { task: task1 } = addWorkflowTask(teamId, workflow.id, "Task", "Desc", 1);

      failTask(teamId, workflow.id, task1.id, "Error 1");
      failTask(teamId, workflow.id, task1.id, "Error 2");
      failTask(teamId, workflow.id, task1.id, "Error 3");

      const { task } = getTaskStatus(teamId, workflow.id, task1.id);
      assert.equal(task?.status, "failed");
      assert.equal(task?.error_message, "Error 3");
    });

    it("retries task if below max retries", () => {
      const { workflow } = createWorkflow(teamId, "Workflow", userId);
      const { task: task1 } = addWorkflowTask(teamId, workflow.id, "Task", "Desc", 1);

      failTask(teamId, workflow.id, task1.id, "Error");

      const { task } = getTaskStatus(teamId, workflow.id, task1.id);
      assert.equal(task?.status, "pending");
      assert.equal(task?.retry_count, 1);
    });

    it("marks workflow as failed", () => {
      const { workflow } = createWorkflow(teamId, "Workflow", userId);
      const { task: task1 } = addWorkflowTask(teamId, workflow.id, "Task", "Desc", 1);

      failTask(teamId, workflow.id, task1.id, "Error 1");
      failTask(teamId, workflow.id, task1.id, "Error 2");
      failTask(teamId, workflow.id, task1.id, "Error 3");

      const { workflow: updated } = getWorkflowStatus(teamId, workflow.id);
      assert.equal(updated?.status, "failed");
    });
  });

  describe("getWorkflowStatus", () => {
    it("gets workflow status", () => {
      const { workflow } = createWorkflow(teamId, "Workflow", userId);

      const { workflow: fetched, error } = getWorkflowStatus(teamId, workflow.id);

      assert.ok(!error);
      assert.equal(fetched?.id, workflow.id);
    });

    it("fails for nonexistent workflow", () => {
      const { workflow, error } = getWorkflowStatus(teamId, "nonexistent");

      assert.ok(error);
      assert.equal(error, "Workflow not found");
      assert.ok(!workflow);
    });
  });

  describe("getTaskStatus", () => {
    it("gets task status", () => {
      const { workflow } = createWorkflow(teamId, "Workflow", userId);
      const { task: task1 } = addWorkflowTask(teamId, workflow.id, "Task", "Desc", 1);

      const { task, error } = getTaskStatus(teamId, workflow.id, task1.id);

      assert.ok(!error);
      assert.equal(task?.id, task1.id);
    });

    it("fails for nonexistent task", () => {
      const { workflow } = createWorkflow(teamId, "Workflow", userId);

      const { task, error } = getTaskStatus(teamId, workflow.id, "nonexistent");

      assert.ok(error);
      assert.ok(!task);
    });
  });

  describe("pauseWorkflow", () => {
    it("pauses workflow", () => {
      const { workflow } = createWorkflow(teamId, "Workflow", userId);

      const { workflow: paused, error } = pauseWorkflow(teamId, workflow.id);

      assert.ok(!error);
      assert.equal(paused.status, "paused");
    });
  });

  describe("resumeWorkflow", () => {
    it("resumes paused workflow", () => {
      const { workflow } = createWorkflow(teamId, "Workflow", userId);
      pauseWorkflow(teamId, workflow.id);

      const { workflow: resumed, error } = resumeWorkflow(teamId, workflow.id);

      assert.ok(!error);
      assert.equal(resumed.status, "active");
    });

    it("fails if workflow not paused", () => {
      const { workflow } = createWorkflow(teamId, "Workflow", userId);

      const { error } = resumeWorkflow(teamId, workflow.id);

      assert.ok(error);
      assert.equal(error, "Workflow is not paused");
    });
  });

  describe("cancelWorkflow", () => {
    it("cancels workflow", () => {
      const { workflow } = createWorkflow(teamId, "Workflow", userId);

      const { workflow: cancelled, error } = cancelWorkflow(teamId, workflow.id);

      assert.ok(!error);
      assert.equal(cancelled.status, "cancelled");
      assert.ok(cancelled.completed_at);
    });
  });

  describe("createWorkflowFromTemplate", () => {
    it("creates workflow from template", () => {
      const { templates } = listWorkflowTemplates();
      assert.ok(templates.length > 0);

      const { workflow, error } = createWorkflowFromTemplate(
        teamId,
        templates[0].id,
        "From Template",
        userId,
      );

      assert.ok(!error);
      assert.ok(workflow.id);
      assert.ok(workflow.tasks.length > 0);
      assert.ok(workflow.coordination.length > 0);
    });

    it("fails for nonexistent template", () => {
      const { error } = createWorkflowFromTemplate(
        teamId,
        "nonexistent-template",
        "Workflow",
        userId,
      );

      assert.ok(error);
      assert.equal(error, "Template not found");
    });
  });

  describe("listWorkflowTemplates", () => {
    it("lists available templates", () => {
      const { templates } = listWorkflowTemplates();

      assert.ok(templates.length > 0);
      assert.ok(templates.some((t) => t.template_name.includes("Code Review")));
      assert.ok(templates.some((t) => t.template_name.includes("Data Pipeline")));
    });

    it("includes template metadata", () => {
      const { templates } = listWorkflowTemplates();

      templates.forEach((t) => {
        assert.ok(t.id);
        assert.ok(t.template_name);
        assert.ok(t.tasks.length > 0);
        assert.ok(t.required_agents > 0);
      });
    });
  });

  describe("getWorkflowMetrics", () => {
    it("returns workflow metrics", () => {
      const team2 = "team-workflow-metrics";
      createWorkflow(team2, "Workflow 1", userId);
      createWorkflow(team2, "Workflow 2", userId);

      const metrics = getWorkflowMetrics(team2);

      assert.equal(metrics.total_workflows, 2);
      assert.ok(metrics.success_rate_percent >= 0);
      assert.ok(metrics.average_duration_minutes > 0);
      assert.ok(metrics.average_tasks_per_workflow >= 0);
    });

    it("calculates success rate", () => {
      const team3 = "team-workflow-success";
      const { workflow } = createWorkflow(team3, "Workflow", userId);
      const { task } = addWorkflowTask(team3, workflow.id, "Task", "Desc", 1);

      executeWorkflow(team3, workflow.id);
      completeTask(team3, workflow.id, task.id);

      const metrics = getWorkflowMetrics(team3);
      assert.equal(metrics.success_rate_percent, 100);
    });
  });
});
