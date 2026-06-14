/**
 * Governance & Approvals System — data models
 * Approval workflows, policies, change tracking
 */

export type ChangeType =
  | "config_change"
  | "secret_access"
  | "service_integration"
  | "policy_update"
  | "member_role_change";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";
export type ApprovalDecision = "approve" | "reject";

export interface ChangeRequest {
  id: string;
  team_id: string;
  type: ChangeType;
  requester_id: string;
  requester_email: string;
  resource_type: string;
  resource_id: string;
  resource_name: string;
  description: string;
  proposed_changes: Record<string, unknown>;
  status: "pending" | "approved" | "rejected" | "executed" | "rolled_back";
  policy_id?: string;
  required_approvals: number;
  collected_approvals: number;
  created_at: string;
  expires_at: string;
  executed_at?: string;
  auto_execute?: boolean; // Execute if all approvals collected
}

export interface ApprovalPolicy {
  id: string;
  team_id: string;
  resource_type: string;
  change_types: ChangeType[];
  required_approvers: number;
  allowed_approver_roles: string[]; // ["admin", "owner"]
  auto_approve_for_roles?: string[]; // Auto-approve for owner changes
  timeout_hours: number; // Approval request expires in N hours
  notification_channels: string[]; // ["email", "slack"]
  created_at: string;
  updated_at: string;
}

export interface Approval {
  id: string;
  request_id: string;
  team_id: string;
  approver_id: string;
  approver_email: string;
  decision: ApprovalDecision;
  status: ApprovalStatus;
  comment?: string;
  approved_at?: string;
  created_at: string;
}

export interface GovernanceLog {
  id: string;
  team_id: string;
  event_type:
    | "change_requested"
    | "approval_requested"
    | "approval_given"
    | "change_executed"
    | "change_rejected"
    | "policy_violated"
    | "policy_created";
  actor_id: string;
  actor_email: string;
  resource_type: string;
  resource_id: string;
  details: Record<string, unknown>;
  timestamp: string;
}

/**
 * Policy evaluation result
 */
export interface PolicyEvaluation {
  requiresApproval: boolean;
  policy?: ApprovalPolicy;
  requiredApprovals: number;
  reason: string;
}

/**
 * Approval statistics for dashboard
 */
export interface ApprovalMetrics {
  total_pending: number;
  total_approved: number;
  total_rejected: number;
  avg_approval_time_hours: number;
  approval_rate_percent: number;
}
