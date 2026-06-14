/**
 * Multi-Agent Workflows — data models
 * Orchestrate complex tasks across multiple agents with coordination and state management
 */

export type WorkflowStatus = "draft" | "active" | "paused" | "completed" | "failed" | "cancelled";
export type TaskStatus =
  | "pending"
  | "assigned"
  | "in_progress"
  | "completed"
  | "failed"
  | "skipped"
  | "waiting";
export type CoordinationType = "sequential" | "parallel" | "fan_out" | "conditional";
export type AgentRole = "primary" | "secondary" | "reviewer" | "observer";

export interface WorkflowTask {
  id: string;
  workflow_id: string;
  task_name: string;
  description: string;
  sequence_order: number;
  status: TaskStatus;
  assigned_agent_id?: string;
  assigned_agent_type?: string; // claude, cursor, cline
  dependencies: string[]; // task IDs this depends on
  input_data?: Record<string, unknown>;
  output_data?: Record<string, unknown>;
  error_message?: string;
  retry_count: number;
  max_retries: number;
  timeout_minutes: number;
  started_at?: string;
  completed_at?: string;
  created_at: string;
  updated_at: string;
}

export interface WorkflowCoordination {
  id: string;
  workflow_id: string;
  coordination_type: CoordinationType;
  condition?: string; // Expression for conditional coordination
  parallel_tasks: string[]; // Task IDs for parallel execution
  sequential_tasks: string[]; // Ordered task IDs for sequential
  fan_out_source_task?: string; // Source task for fan-out
  fan_out_targets?: string[]; // Target task IDs
  created_at: string;
  updated_at: string;
}

export interface MultiAgentWorkflow {
  id: string;
  team_id: string;
  workflow_name: string;
  description?: string;
  status: WorkflowStatus;
  tasks: WorkflowTask[];
  coordination: WorkflowCoordination[];
  agents: {
    agent_id: string;
    agent_type: string;
    role: AgentRole;
    assigned_tasks: string[];
  }[];
  input_data?: Record<string, unknown>;
  output_data?: Record<string, unknown>;
  max_parallel_tasks: number;
  timeout_minutes: number;
  created_by: string;
  started_at?: string;
  completed_at?: string;
  estimated_completion?: string;
  created_at: string;
  updated_at: string;
}

export interface WorkflowExecution {
  id: string;
  workflow_id: string;
  team_id: string;
  execution_status: WorkflowStatus;
  tasks_completed: number;
  tasks_failed: number;
  tasks_pending: number;
  overall_progress_percent: number;
  started_at: string;
  completed_at?: string;
  duration_minutes?: number;
  error_count: number;
  warning_count: number;
  created_at: string;
  updated_at: string;
}

export interface AgentCoordination {
  id: string;
  workflow_id: string;
  team_id: string;
  agents: {
    agent_id: string;
    agent_type: string;
    role: AgentRole;
  }[];
  shared_context: Record<string, unknown>;
  handoff_enabled: boolean;
  result_aggregation_mode: "merge" | "sequential" | "consensus";
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface WorkflowMetrics {
  total_workflows: number;
  active_workflows: number;
  completed_workflows: number;
  failed_workflows: number;
  average_duration_minutes: number;
  average_tasks_per_workflow: number;
  most_used_coordination_type: CoordinationType;
  agent_utilization_percent: number;
  success_rate_percent: number;
  average_retries: number;
}

export interface WorkflowTemplate {
  id: string;
  template_name: string;
  description?: string;
  category: string;
  tasks: Omit<WorkflowTask, "id" | "workflow_id" | "created_at" | "updated_at">[];
  coordination: Omit<WorkflowCoordination, "id" | "workflow_id" | "created_at" | "updated_at">[];
  required_agents: number;
  estimated_duration_minutes: number;
  complexity: "simple" | "moderate" | "complex";
  public: boolean;
  created_at: string;
  updated_at: string;
}
