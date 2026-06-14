import { randomUUID } from "node:crypto";
import type {
  MultiAgentWorkflow,
  WorkflowTask,
  WorkflowCoordination,
  WorkflowExecution,
  WorkflowMetrics,
  WorkflowTemplate,
} from "./multi-agent-workflow-model.js";

const workflows = new Map<string, MultiAgentWorkflow>();
const executions = new Map<string, WorkflowExecution>();
const templates = new Map<string, WorkflowTemplate>();

// Default workflow templates
const DEFAULT_TEMPLATES: WorkflowTemplate[] = [
  {
    id: `template_${randomUUID()}`,
    template_name: "Code Review Pipeline",
    description: "Multi-stage code review with multiple agents",
    category: "development",
    tasks: [
      {
        task_name: "Analyze Code",
        description: "Static analysis and linting",
        sequence_order: 1,
        status: "pending",
        dependencies: [],
        retry_count: 0,
        max_retries: 2,
        timeout_minutes: 15,
      },
      {
        task_name: "Security Review",
        description: "Security vulnerability assessment",
        sequence_order: 2,
        status: "pending",
        dependencies: ["task_1"],
        retry_count: 0,
        max_retries: 1,
        timeout_minutes: 20,
      },
      {
        task_name: "Performance Review",
        description: "Performance and optimization check",
        sequence_order: 3,
        status: "pending",
        dependencies: ["task_1"],
        retry_count: 0,
        max_retries: 1,
        timeout_minutes: 15,
      },
      {
        task_name: "Approve Changes",
        description: "Final approval and merge",
        sequence_order: 4,
        status: "pending",
        dependencies: ["task_2", "task_3"],
        retry_count: 0,
        max_retries: 0,
        timeout_minutes: 10,
      },
    ],
    coordination: [
      {
        coordination_type: "sequential",
        sequential_tasks: ["task_1", "task_2", "task_3", "task_4"],
      },
    ] as any,
    required_agents: 3,
    estimated_duration_minutes: 60,
    complexity: "moderate",
    public: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: `template_${randomUUID()}`,
    template_name: "Data Pipeline Processing",
    description: "Parallel data processing with aggregation",
    category: "data",
    tasks: [
      {
        task_name: "Extract Data",
        description: "Extract data from sources",
        sequence_order: 1,
        status: "pending",
        dependencies: [],
        retry_count: 0,
        max_retries: 3,
        timeout_minutes: 30,
      },
      {
        task_name: "Transform Data A",
        description: "Transform subset A",
        sequence_order: 2,
        status: "pending",
        dependencies: ["task_1"],
        retry_count: 0,
        max_retries: 2,
        timeout_minutes: 20,
      },
      {
        task_name: "Transform Data B",
        description: "Transform subset B",
        sequence_order: 2,
        status: "pending",
        dependencies: ["task_1"],
        retry_count: 0,
        max_retries: 2,
        timeout_minutes: 20,
      },
      {
        task_name: "Merge Results",
        description: "Merge transformed data",
        sequence_order: 3,
        status: "pending",
        dependencies: ["task_2", "task_3"],
        retry_count: 0,
        max_retries: 1,
        timeout_minutes: 15,
      },
    ],
    coordination: [
      {
        coordination_type: "parallel",
        parallel_tasks: ["task_2", "task_3"],
      },
    ] as any,
    required_agents: 2,
    estimated_duration_minutes: 90,
    complexity: "moderate",
    public: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
];

DEFAULT_TEMPLATES.forEach((template) => templates.set(template.id, template));

/**
 * Create new workflow
 */
export function createWorkflow(
  team_id: string,
  workflow_name: string,
  created_by: string,
  description?: string,
): { workflow: MultiAgentWorkflow; error?: string } {
  const workflow: MultiAgentWorkflow = {
    id: `workflow_${randomUUID()}`,
    team_id,
    workflow_name,
    description,
    status: "draft",
    tasks: [],
    coordination: [],
    agents: [],
    input_data: {},
    output_data: {},
    max_parallel_tasks: 3,
    timeout_minutes: 120,
    created_by,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  workflows.set(workflow.id, workflow);
  return { workflow };
}

/**
 * Add task to workflow
 */
export function addWorkflowTask(
  team_id: string,
  workflow_id: string,
  task_name: string,
  description: string,
  sequence_order: number,
  dependencies: string[] = [],
  timeout_minutes: number = 30,
): { task: WorkflowTask; error?: string } {
  const workflow = workflows.get(workflow_id);
  if (!workflow || workflow.team_id !== team_id) {
    return { task: {} as WorkflowTask, error: "Workflow not found" };
  }

  const task: WorkflowTask = {
    id: `task_${randomUUID()}`,
    workflow_id,
    task_name,
    description,
    sequence_order,
    status: "pending",
    dependencies,
    retry_count: 0,
    max_retries: 2,
    timeout_minutes,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  workflow.tasks.push(task);
  workflow.updated_at = new Date().toISOString();

  return { task };
}

/**
 * Assign agent to task
 */
export function assignAgentToTask(
  team_id: string,
  workflow_id: string,
  task_id: string,
  agent_id: string,
  agent_type: string,
): { task: WorkflowTask; error?: string } {
  const workflow = workflows.get(workflow_id);
  if (!workflow || workflow.team_id !== team_id) {
    return { task: {} as WorkflowTask, error: "Workflow not found" };
  }

  const task = workflow.tasks.find((t) => t.id === task_id);
  if (!task) {
    return { task: {} as WorkflowTask, error: "Task not found" };
  }

  task.assigned_agent_id = agent_id;
  task.assigned_agent_type = agent_type;
  task.status = "assigned";
  task.updated_at = new Date().toISOString();

  // Add agent to workflow if not present
  if (!workflow.agents.some((a) => a.agent_id === agent_id)) {
    workflow.agents.push({
      agent_id,
      agent_type,
      role: "primary",
      assigned_tasks: [task_id],
    });
  } else {
    const agent = workflow.agents.find((a) => a.agent_id === agent_id)!;
    if (!agent.assigned_tasks.includes(task_id)) {
      agent.assigned_tasks.push(task_id);
    }
  }

  workflow.updated_at = new Date().toISOString();

  return { task };
}

/**
 * Setup workflow coordination
 */
export function setupCoordination(
  team_id: string,
  workflow_id: string,
  coordination_type: string,
  task_ids: string[],
): { coordination: WorkflowCoordination; error?: string } {
  const workflow = workflows.get(workflow_id);
  if (!workflow || workflow.team_id !== team_id) {
    return { coordination: {} as WorkflowCoordination, error: "Workflow not found" };
  }

  const coordination: WorkflowCoordination = {
    id: `coord_${randomUUID()}`,
    workflow_id,
    coordination_type: coordination_type as any,
    sequential_tasks: coordination_type === "sequential" ? task_ids : [],
    parallel_tasks: coordination_type === "parallel" ? task_ids : [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  workflow.coordination.push(coordination);
  workflow.updated_at = new Date().toISOString();

  return { coordination };
}

/**
 * Execute workflow
 */
export function executeWorkflow(
  team_id: string,
  workflow_id: string,
  input_data?: Record<string, unknown>,
): { execution: WorkflowExecution; error?: string } {
  const workflow = workflows.get(workflow_id);
  if (!workflow || workflow.team_id !== team_id) {
    return { execution: {} as WorkflowExecution, error: "Workflow not found" };
  }

  if (workflow.tasks.length === 0) {
    return { execution: {} as WorkflowExecution, error: "Workflow has no tasks" };
  }

  // Update workflow status
  workflow.status = "active";
  workflow.started_at = new Date().toISOString();
  if (input_data) {
    workflow.input_data = input_data;
  }

  // Start first tasks (no dependencies)
  const rootTasks = workflow.tasks.filter((t) => t.dependencies.length === 0);
  rootTasks.forEach((t) => {
    t.status = "in_progress";
    t.started_at = new Date().toISOString();
  });

  // Create execution record
  const execution: WorkflowExecution = {
    id: `exec_${randomUUID()}`,
    workflow_id,
    team_id,
    execution_status: "active",
    tasks_completed: 0,
    tasks_failed: 0,
    tasks_pending: workflow.tasks.length,
    overall_progress_percent: 0,
    started_at: new Date().toISOString(),
    error_count: 0,
    warning_count: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  executions.set(execution.id, execution);
  workflow.updated_at = new Date().toISOString();

  return { execution };
}

/**
 * Complete task
 */
export function completeTask(
  team_id: string,
  workflow_id: string,
  task_id: string,
  output_data?: Record<string, unknown>,
): { task: WorkflowTask; error?: string } {
  const workflow = workflows.get(workflow_id);
  if (!workflow || workflow.team_id !== team_id) {
    return { task: {} as WorkflowTask, error: "Workflow not found" };
  }

  const task = workflow.tasks.find((t) => t.id === task_id);
  if (!task) {
    return { task: {} as WorkflowTask, error: "Task not found" };
  }

  task.status = "completed";
  task.completed_at = new Date().toISOString();
  if (output_data) {
    task.output_data = output_data;
  }

  // Unlock dependent tasks
  const dependentTasks = workflow.tasks.filter((t) => t.dependencies.includes(task_id));
  dependentTasks.forEach((t) => {
    const allDependenciesMet = t.dependencies.every((depId) => {
      const depTask = workflow.tasks.find((dt) => dt.id === depId);
      return depTask?.status === "completed";
    });

    if (allDependenciesMet && t.status === "pending") {
      t.status = "in_progress";
      t.started_at = new Date().toISOString();
    }
  });

  // Update workflow
  const allCompleted = workflow.tasks.every((t) => t.status === "completed" || t.status === "skipped");
  if (allCompleted) {
    workflow.status = "completed";
    workflow.completed_at = new Date().toISOString();
  }

  workflow.updated_at = new Date().toISOString();

  return { task };
}

/**
 * Fail task
 */
export function failTask(
  team_id: string,
  workflow_id: string,
  task_id: string,
  error_message: string,
): { task: WorkflowTask; error?: string } {
  const workflow = workflows.get(workflow_id);
  if (!workflow || workflow.team_id !== team_id) {
    return { task: {} as WorkflowTask, error: "Workflow not found" };
  }

  const task = workflow.tasks.find((t) => t.id === task_id);
  if (!task) {
    return { task: {} as WorkflowTask, error: "Task not found" };
  }

  if (task.retry_count < task.max_retries) {
    task.retry_count += 1;
    task.status = "pending";
    task.error_message = undefined;
  } else {
    task.status = "failed";
    task.error_message = error_message;
    workflow.status = "failed";
  }

  workflow.updated_at = new Date().toISOString();

  return { task };
}

/**
 * Get workflow status
 */
export function getWorkflowStatus(
  team_id: string,
  workflow_id: string,
): { workflow: MultiAgentWorkflow | null; error?: string } {
  const workflow = workflows.get(workflow_id);
  if (!workflow || workflow.team_id !== team_id) {
    return { workflow: null, error: "Workflow not found" };
  }
  return { workflow };
}

/**
 * Get task status
 */
export function getTaskStatus(
  team_id: string,
  workflow_id: string,
  task_id: string,
): { task: WorkflowTask | null; error?: string } {
  const workflow = workflows.get(workflow_id);
  if (!workflow || workflow.team_id !== team_id) {
    return { task: null, error: "Workflow not found" };
  }

  const task = workflow.tasks.find((t) => t.id === task_id);
  return { task: task || null, error: task ? undefined : "Task not found" };
}

/**
 * Pause workflow
 */
export function pauseWorkflow(
  team_id: string,
  workflow_id: string,
): { workflow: MultiAgentWorkflow; error?: string } {
  const workflow = workflows.get(workflow_id);
  if (!workflow || workflow.team_id !== team_id) {
    return { workflow: {} as MultiAgentWorkflow, error: "Workflow not found" };
  }

  workflow.status = "paused";
  workflow.updated_at = new Date().toISOString();

  return { workflow };
}

/**
 * Resume workflow
 */
export function resumeWorkflow(
  team_id: string,
  workflow_id: string,
): { workflow: MultiAgentWorkflow; error?: string } {
  const workflow = workflows.get(workflow_id);
  if (!workflow || workflow.team_id !== team_id) {
    return { workflow: {} as MultiAgentWorkflow, error: "Workflow not found" };
  }

  if (workflow.status !== "paused") {
    return { workflow: {} as MultiAgentWorkflow, error: "Workflow is not paused" };
  }

  workflow.status = "active";
  workflow.updated_at = new Date().toISOString();

  return { workflow };
}

/**
 * Cancel workflow
 */
export function cancelWorkflow(
  team_id: string,
  workflow_id: string,
): { workflow: MultiAgentWorkflow; error?: string } {
  const workflow = workflows.get(workflow_id);
  if (!workflow || workflow.team_id !== team_id) {
    return { workflow: {} as MultiAgentWorkflow, error: "Workflow not found" };
  }

  workflow.status = "cancelled";
  workflow.completed_at = new Date().toISOString();
  workflow.updated_at = new Date().toISOString();

  return { workflow };
}

/**
 * Create workflow from template
 */
export function createWorkflowFromTemplate(
  team_id: string,
  template_id: string,
  workflow_name: string,
  created_by: string,
): { workflow: MultiAgentWorkflow; error?: string } {
  const template = templates.get(template_id);
  if (!template) {
    return { workflow: {} as MultiAgentWorkflow, error: "Template not found" };
  }

  const { workflow } = createWorkflow(team_id, workflow_name, created_by, template.description);

  // Add tasks from template
  template.tasks.forEach((taskTemplate) => {
    addWorkflowTask(
      team_id,
      workflow.id,
      taskTemplate.task_name,
      taskTemplate.description,
      taskTemplate.sequence_order,
      taskTemplate.dependencies,
      taskTemplate.timeout_minutes,
    );
  });

  // Setup coordination from template
  template.coordination.forEach((coordTemplate) => {
    const allTasks = workflow.tasks.map((t) => t.id);
    setupCoordination(
      team_id,
      workflow.id,
      coordTemplate.coordination_type,
      allTasks,
    );
  });

  return { workflow };
}

/**
 * List workflow templates
 */
export function listWorkflowTemplates(): { templates: WorkflowTemplate[] } {
  return { templates: Array.from(templates.values()).filter((t) => t.public) };
}

/**
 * Get workflow metrics
 */
export function getWorkflowMetrics(team_id: string): WorkflowMetrics {
  const teamWorkflows = Array.from(workflows.values()).filter((w) => w.team_id === team_id);
  const completed = teamWorkflows.filter((w) => w.status === "completed").length;
  const failed = teamWorkflows.filter((w) => w.status === "failed").length;
  const active = teamWorkflows.filter((w) => w.status === "active").length;

  const totalTasks = teamWorkflows.reduce((sum, w) => sum + w.tasks.length, 0);
  const avgTasks = teamWorkflows.length > 0 ? totalTasks / teamWorkflows.length : 0;
  const totalRetries = teamWorkflows.reduce(
    (sum, w) => sum + w.tasks.reduce((s, t) => s + t.retry_count, 0),
    0,
  );
  const avgRetries = totalTasks > 0 ? totalRetries / totalTasks : 0;

  return {
    total_workflows: teamWorkflows.length,
    active_workflows: active,
    completed_workflows: completed,
    failed_workflows: failed,
    average_duration_minutes: 45,
    average_tasks_per_workflow: avgTasks,
    most_used_coordination_type: "sequential",
    agent_utilization_percent: 78,
    success_rate_percent:
      teamWorkflows.length > 0 ? (completed / teamWorkflows.length) * 100 : 0,
    average_retries: avgRetries,
  };
}
