/**
 * Certification Workflow Engine — data models
 * Multi-stage approval workflow for plugin certifications
 */

export type WorkflowStage = "validation" | "review" | "approval" | "release" | "completed";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "escalated" | "blocked";
export type ReviewerRole = "validator" | "reviewer" | "approver" | "release_manager" | "admin";

export interface CertificationWorkflow {
  id: string;
  plugin_id: string;
  plugin_version: string;
  plugin_name: string;
  current_stage: WorkflowStage;
  status: ApprovalStatus;
  validation_report_id?: string;
  created_by: string;
  created_at: string;
  started_at?: string;
  completed_at?: string;
  expires_at?: string;
  stages_completed: WorkflowStage[];
  approval_chain: ApprovalStep[];
  audit_trail: WorkflowAuditEvent[];
}

export interface ApprovalStep {
  id: string;
  workflow_id: string;
  stage: WorkflowStage;
  step_number: number;
  required_role: ReviewerRole;
  assigned_to?: string;
  assigned_to_name?: string;
  status: ApprovalStatus;
  approved_by?: string;
  approved_by_name?: string;
  approved_at?: string;
  rejection_reason?: string;
  comments?: string;
  deadline?: string;
  escalated: boolean;
  escalated_to?: string;
  created_at: string;
  updated_at: string;
}

export interface WorkflowAuditEvent {
  id: string;
  workflow_id: string;
  stage: WorkflowStage;
  event_type: string; // "stage_entered", "approved", "rejected", "commented", "escalated"
  actor_id: string;
  actor_name: string;
  actor_role: ReviewerRole;
  details: Record<string, unknown>;
  timestamp: string;
  created_at: string;
}

export interface ApprovalChainTemplate {
  id: string;
  name: string;
  certification_tier: string; // bronze, silver, gold, platinum
  stages: {
    stage: WorkflowStage;
    step_number: number;
    required_role: ReviewerRole;
    min_approval_count: number;
    escalation_deadline_hours?: number;
    can_auto_approve?: boolean;
  }[];
  created_at: string;
  updated_at: string;
}

export interface WorkflowMetrics {
  total_workflows: number;
  active_workflows: number;
  completed_workflows: number;
  failed_workflows: number;
  average_completion_hours: number;
  average_stage_duration_hours: Record<WorkflowStage, number>;
  approval_rate_percent: number;
  rejection_rate_percent: number;
  escalation_rate_percent: number;
  bottleneck_stage: WorkflowStage;
}

export interface ReviewerAssignment {
  id: string;
  workflow_id: string;
  approval_step_id: string;
  reviewer_id: string;
  reviewer_name: string;
  reviewer_role: ReviewerRole;
  assigned_at: string;
  response_deadline: string;
  responded_at?: string;
  response: "approved" | "rejected" | "escalated" | "no_response";
}
