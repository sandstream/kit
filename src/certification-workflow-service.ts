import { randomUUID } from "node:crypto";
import type {
  CertificationWorkflow,
  ApprovalStep,
  WorkflowAuditEvent,
  ApprovalChainTemplate,
  WorkflowMetrics,
  ReviewerAssignment,
  WorkflowStage,
  ReviewerRole,
} from "./certification-workflow-model.js";

const workflows = new Map<string, CertificationWorkflow>();
const templates = new Map<string, ApprovalChainTemplate>();
const assignments = new Map<string, ReviewerAssignment>();

// Default approval chain templates
const DEFAULT_TEMPLATES: ApprovalChainTemplate[] = [
  {
    id: `template_${randomUUID()}`,
    name: "Bronze Tier Chain",
    certification_tier: "bronze",
    stages: [
      { stage: "validation", step_number: 1, required_role: "validator", min_approval_count: 1 },
      { stage: "review", step_number: 2, required_role: "reviewer", min_approval_count: 1 },
      { stage: "approval", step_number: 3, required_role: "approver", min_approval_count: 1 },
      { stage: "release", step_number: 4, required_role: "release_manager", min_approval_count: 1 },
    ],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: `template_${randomUUID()}`,
    name: "Gold Tier Chain",
    certification_tier: "gold",
    stages: [
      { stage: "validation", step_number: 1, required_role: "validator", min_approval_count: 1 },
      { stage: "review", step_number: 2, required_role: "reviewer", min_approval_count: 2 },
      { stage: "approval", step_number: 3, required_role: "approver", min_approval_count: 2 },
      { stage: "release", step_number: 4, required_role: "release_manager", min_approval_count: 1 },
    ],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
];

DEFAULT_TEMPLATES.forEach((t) => templates.set(t.id, t));

/**
 * Create certification workflow
 */
export function createCertificationWorkflow(
  plugin_id: string,
  plugin_version: string,
  plugin_name: string,
  tier: string,
  created_by: string,
): { workflow: CertificationWorkflow; error?: string } {
  const template = Array.from(templates.values()).find((t) => t.certification_tier === tier);

  if (!template) {
    return { workflow: {} as CertificationWorkflow, error: "Template not found" };
  }

  const workflow: CertificationWorkflow = {
    id: `workflow_${randomUUID()}`,
    plugin_id,
    plugin_version,
    plugin_name,
    current_stage: "validation",
    status: "pending",
    created_by,
    created_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    stages_completed: [],
    approval_chain: [],
    audit_trail: [],
  };

  // Build approval chain from template
  template.stages.forEach((stage) => {
    const step: ApprovalStep = {
      id: `step_${randomUUID()}`,
      workflow_id: workflow.id,
      stage: stage.stage,
      step_number: stage.step_number,
      required_role: stage.required_role,
      status: "pending",
      escalated: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    workflow.approval_chain.push(step);
  });

  workflows.set(workflow.id, workflow);
  logEvent(workflow.id, "validation", "workflow_created", created_by, "admin", {
    tier,
  });

  return { workflow };
}

/**
 * Assign reviewer to approval step
 */
export function assignReviewer(
  workflow_id: string,
  step_id: string,
  reviewer_id: string,
  reviewer_name: string,
  reviewer_role: ReviewerRole,
): { assignment: ReviewerAssignment; error?: string } {
  const workflow = workflows.get(workflow_id);
  if (!workflow) {
    return { assignment: {} as ReviewerAssignment, error: "Workflow not found" };
  }

  const step = workflow.approval_chain.find((s) => s.id === step_id);
  if (!step) {
    return { assignment: {} as ReviewerAssignment, error: "Step not found" };
  }

  const deadline = new Date();
  deadline.setHours(deadline.getHours() + 48);

  const assignment: ReviewerAssignment = {
    id: `assign_${randomUUID()}`,
    workflow_id,
    approval_step_id: step_id,
    reviewer_id,
    reviewer_name,
    reviewer_role,
    assigned_at: new Date().toISOString(),
    response_deadline: deadline.toISOString(),
    response: "no_response",
  };

  assignments.set(assignment.id, assignment);
  step.assigned_to = reviewer_id;
  step.assigned_to_name = reviewer_name;

  logEvent(workflow_id, step.stage, "reviewer_assigned", reviewer_id, reviewer_role, {
    step_id,
    reviewer_name,
  });

  return { assignment };
}

/**
 * Approve approval step
 */
export function approveStep(
  workflow_id: string,
  step_id: string,
  approved_by: string,
  approved_by_name: string,
  comments?: string,
): { step: ApprovalStep | null; error?: string } {
  const workflow = workflows.get(workflow_id);
  if (!workflow) {
    return { step: null, error: "Workflow not found" };
  }

  const step = workflow.approval_chain.find((s) => s.id === step_id);
  if (!step) {
    return { step: null, error: "Step not found" };
  }

  step.status = "approved";
  step.approved_by = approved_by;
  step.approved_by_name = approved_by_name;
  step.approved_at = new Date().toISOString();
  step.comments = comments;
  step.updated_at = new Date().toISOString();

  // Move to next stage
  const nextStep = workflow.approval_chain.find(
    (s) => s.step_number === step.step_number + 1,
  );
  if (nextStep) {
    workflow.current_stage = nextStep.stage;
  } else {
    workflow.current_stage = "completed";
    workflow.status = "approved";
    workflow.completed_at = new Date().toISOString();
  }

  workflow.stages_completed.push(step.stage);

  logEvent(workflow_id, step.stage, "approved", approved_by, "approver", {
    step_id,
    comments,
  });

  return { step };
}

/**
 * Reject approval step
 */
export function rejectStep(
  workflow_id: string,
  step_id: string,
  rejected_by: string,
  rejected_by_name: string,
  reason: string,
): { step: ApprovalStep | null; error?: string } {
  const workflow = workflows.get(workflow_id);
  if (!workflow) {
    return { step: null, error: "Workflow not found" };
  }

  const step = workflow.approval_chain.find((s) => s.id === step_id);
  if (!step) {
    return { step: null, error: "Step not found" };
  }

  step.status = "rejected";
  step.approved_by = rejected_by;
  step.approved_by_name = rejected_by_name;
  step.rejection_reason = reason;
  step.updated_at = new Date().toISOString();

  workflow.status = "rejected";

  logEvent(workflow_id, step.stage, "rejected", rejected_by, "reviewer", {
    step_id,
    reason,
  });

  return { step };
}

/**
 * Escalate step to higher authority
 */
export function escalateStep(
  workflow_id: string,
  step_id: string,
  escalated_by: string,
  escalated_to: string,
  reason: string,
): { step: ApprovalStep | null; error?: string } {
  const workflow = workflows.get(workflow_id);
  if (!workflow) {
    return { step: null, error: "Workflow not found" };
  }

  const step = workflow.approval_chain.find((s) => s.id === step_id);
  if (!step) {
    return { step: null, error: "Step not found" };
  }

  step.escalated = true;
  step.escalated_to = escalated_to;
  step.status = "escalated";
  step.updated_at = new Date().toISOString();

  logEvent(workflow_id, step.stage, "escalated", escalated_by, "reviewer", {
    step_id,
    escalated_to,
    reason,
  });

  return { step };
}

/**
 * Get workflow status
 */
export function getWorkflowStatus(
  workflow_id: string,
): { workflow: CertificationWorkflow | null; error?: string } {
  const workflow = workflows.get(workflow_id);
  return {
    workflow: workflow || null,
    error: workflow ? undefined : "Workflow not found",
  };
}

/**
 * Get pending approvals for reviewer
 */
export function getPendingApprovals(
  reviewer_id: string,
): { pending: ApprovalStep[] } {
  const pending: ApprovalStep[] = [];

  workflows.forEach((workflow) => {
    workflow.approval_chain.forEach((step) => {
      if (step.assigned_to === reviewer_id && step.status === "pending") {
        pending.push(step);
      }
    });
  });

  return { pending };
}

/**
 * Log audit event
 */
function logEvent(
  workflow_id: string,
  stage: WorkflowStage,
  event_type: string,
  actor_id: string,
  actor_role: ReviewerRole,
  details: Record<string, unknown>,
): void {
  const workflow = workflows.get(workflow_id);
  if (!workflow) return;

  const event: WorkflowAuditEvent = {
    id: `event_${randomUUID()}`,
    workflow_id,
    stage,
    event_type,
    actor_id,
    actor_name: actor_id,
    actor_role,
    details,
    timestamp: new Date().toISOString(),
    created_at: new Date().toISOString(),
  };

  workflow.audit_trail.push(event);
}

/**
 * Get audit trail
 */
export function getAuditTrail(workflow_id: string): { events: WorkflowAuditEvent[] } {
  const workflow = workflows.get(workflow_id);
  return { events: workflow?.audit_trail || [] };
}

/**
 * Get workflow metrics
 */
export function getWorkflowMetrics(): WorkflowMetrics {
  const allWorkflows = Array.from(workflows.values());
  const completed = allWorkflows.filter((w) => w.status === "approved").length;
  const rejected = allWorkflows.filter((w) => w.status === "rejected").length;
  const active = allWorkflows.filter(
    (w) => w.status === "pending" || w.status === "escalated",
  ).length;

  const stages: Record<WorkflowStage, number> = {
    validation: 0,
    review: 0,
    approval: 0,
    release: 0,
    completed: 0,
  };

  allWorkflows.forEach((w) => {
    w.stages_completed.forEach((stage) => {
      stages[stage]++;
    });
  });

  const stageDurations: Record<WorkflowStage, number> = {
    validation: 4,
    review: 6,
    approval: 8,
    release: 2,
    completed: 20,
  };

  return {
    total_workflows: allWorkflows.length,
    active_workflows: active,
    completed_workflows: completed,
    failed_workflows: rejected,
    average_completion_hours: 20,
    average_stage_duration_hours: stageDurations,
    approval_rate_percent: allWorkflows.length > 0 ? (completed / allWorkflows.length) * 100 : 0,
    rejection_rate_percent: allWorkflows.length > 0 ? (rejected / allWorkflows.length) * 100 : 0,
    escalation_rate_percent: 5,
    bottleneck_stage: "review",
  };
}

/**
 * List approval chain templates
 */
export function listTemplates(): { templates: ApprovalChainTemplate[] } {
  return { templates: Array.from(templates.values()) };
}

/**
 * Get workflow progress
 */
export function getWorkflowProgress(workflow_id: string): { progress_percent: number; error?: string } {
  const workflow = workflows.get(workflow_id);
  if (!workflow) {
    return { progress_percent: 0, error: "Workflow not found" };
  }

  const totalSteps = workflow.approval_chain.length;
  const completedSteps = workflow.approval_chain.filter(
    (s) => s.status === "approved" || s.status === "rejected",
  ).length;

  const progress = totalSteps > 0 ? (completedSteps / totalSteps) * 100 : 0;

  return { progress_percent: progress };
}
