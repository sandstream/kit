import { randomUUID } from "node:crypto";
import type {
  ChangeRequest,
  ApprovalPolicy,
  Approval,
  GovernanceLog,
  ChangeType,
  ApprovalDecision,
  PolicyEvaluation,
  ApprovalMetrics,
} from "./approval-model.js";

/**
 * In-memory storage (production would use database)
 */
const changeRequests = new Map<string, ChangeRequest>();
const approvalPolicies = new Map<string, ApprovalPolicy>();
const approvals = new Map<string, Approval>();
const governanceLogs: GovernanceLog[] = [];

/**
 * Default policies per resource type
 */
const DEFAULT_POLICIES: Record<string, Partial<ApprovalPolicy>> = {
  config_change: {
    required_approvers: 1,
    allowed_approver_roles: ["owner", "admin"],
    timeout_hours: 24,
  },
  secret_access: {
    required_approvers: 2,
    allowed_approver_roles: ["owner"],
    timeout_hours: 1,
  },
  service_integration: {
    required_approvers: 1,
    allowed_approver_roles: ["owner", "admin"],
    timeout_hours: 24,
  },
};

/**
 * Create approval policy
 */
export function createApprovalPolicy(
  team_id: string,
  resource_type: string,
  required_approvers: number,
  allowed_roles: string[] = ["owner", "admin"],
): { policy: ApprovalPolicy; error?: string } {
  if (required_approvers < 1) {
    return { policy: {} as ApprovalPolicy, error: "At least 1 approver required" };
  }

  const policy: ApprovalPolicy = {
    id: `policy_${randomUUID()}`,
    team_id,
    resource_type,
    change_types: ["config_change", "secret_access", "service_integration"],
    required_approvers,
    allowed_approver_roles: allowed_roles,
    timeout_hours: 24,
    notification_channels: ["email"],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  approvalPolicies.set(policy.id, policy);
  logGovernance(team_id, "system", "policy_created", resource_type, policy.id, {
    required_approvers,
    allowed_roles,
  });

  return { policy };
}

/**
 * Request change approval
 */
export function requestChangeApproval(
  team_id: string,
  change_type: ChangeType,
  requester_id: string,
  requester_email: string,
  resource_type: string,
  resource_id: string,
  resource_name: string,
  description: string,
  proposed_changes: Record<string, unknown>,
): { request: ChangeRequest; error?: string } {
  // Evaluate policy
  const evaluation = evaluatePolicy(team_id, change_type, resource_type);

  const timeoutHours = evaluation.policy?.timeout_hours ?? 24;

  const changeRequest: ChangeRequest = {
    id: `change_${randomUUID()}`,
    team_id,
    type: change_type,
    requester_id,
    requester_email,
    resource_type,
    resource_id,
    resource_name,
    description,
    proposed_changes,
    status: evaluation.requiresApproval ? "pending" : "approved",
    policy_id: evaluation.policy?.id,
    required_approvals: evaluation.requiredApprovals,
    collected_approvals: 0,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + timeoutHours * 60 * 60 * 1000).toISOString(),
    auto_execute: true,
  };

  changeRequests.set(changeRequest.id, changeRequest);
  logGovernance(
    team_id,
    requester_id,
    "change_requested",
    resource_type,
    resource_id,
    {
      change_type,
      requires_approval: evaluation.requiresApproval,
      required_approvals: evaluation.requiredApprovals,
    },
  );

  return { request: changeRequest };
}

/**
 * Approve or reject change
 */
export function respondToApprovalRequest(
  request_id: string,
  approver_id: string,
  approver_email: string,
  decision: ApprovalDecision,
  comment?: string,
): { approval: Approval; error?: string } {
  const request = changeRequests.get(request_id);
  if (!request) {
    return { approval: {} as Approval, error: "Change request not found" };
  }

  // Check expiry
  if (new Date(request.expires_at) < new Date()) {
    return { approval: {} as Approval, error: "Approval request expired" };
  }

  // Check if already approved/rejected
  if (request.status !== "pending") {
    return { approval: {} as Approval, error: "Request already processed" };
  }

  const approval: Approval = {
    id: `approval_${randomUUID()}`,
    request_id,
    team_id: request.team_id,
    approver_id,
    approver_email,
    decision,
    status: decision === "approve" ? "approved" : "rejected",
    comment,
    approved_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
  };

  approvals.set(approval.id, approval);

  // Update request status
  if (decision === "approve") {
    request.collected_approvals += 1;

    if (request.collected_approvals >= request.required_approvals) {
      request.status = "approved";
      logGovernance(request.team_id, approver_id, "change_executed", request.resource_type, request.resource_id, {
        change_id: request.id,
        total_approvals: request.collected_approvals,
      });
    }
  } else {
    request.status = "rejected";
    logGovernance(request.team_id, approver_id, "change_rejected", request.resource_type, request.resource_id, {
      change_id: request.id,
      reason: comment,
    });
  }

  logGovernance(request.team_id, approver_id, "approval_given", request.resource_type, request.resource_id, {
    change_id: request.id,
    decision,
    comment,
  });

  return { approval };
}

/**
 * Evaluate if change requires approval based on policy
 */
function evaluatePolicy(
  team_id: string,
  change_type: ChangeType,
  resource_type: string,
): PolicyEvaluation {
  // Check for existing custom policy
  const customPolicy = Array.from(approvalPolicies.values()).find(
    (p) => p.team_id === team_id && p.resource_type === resource_type,
  );

  if (customPolicy) {
    return {
      requiresApproval: true,
      policy: customPolicy,
      requiredApprovals: customPolicy.required_approvers,
      reason: `Requires ${customPolicy.required_approvers} approvals per team policy`,
    };
  }

  // Check default policy based on change_type
  const defaultPolicy = DEFAULT_POLICIES[change_type];
  if (defaultPolicy) {
    return {
      requiresApproval: true,
      requiredApprovals: defaultPolicy.required_approvers || 1,
      reason: `Requires ${defaultPolicy.required_approvers || 1} approvals per default policy`,
    };
  }

  return {
    requiresApproval: false,
    requiredApprovals: 0,
    reason: "No approval policy configured",
  };
}

/**
 * Get pending approvals for user
 */
export function getPendingApprovalsForUser(
  user_id: string,
): { requests: ChangeRequest[] } {
  const userApprovals = Array.from(approvals.values()).filter(
    (a) => a.approver_id === user_id && a.status === "approved",
  );

  const requestIds = new Set(userApprovals.map((a) => a.request_id));
  const pending = Array.from(changeRequests.values()).filter(
    (r) => r.status === "pending" && !requestIds.has(r.id),
  );

  return { requests: pending };
}

/**
 * Get approval metrics
 */
export function getApprovalMetrics(team_id: string): ApprovalMetrics {
  const teamRequests = Array.from(changeRequests.values()).filter((r) => r.team_id === team_id);

  const approved = teamRequests.filter((r) => r.status === "approved");
  const rejected = teamRequests.filter((r) => r.status === "rejected");
  const pending = teamRequests.filter((r) => r.status === "pending");

  let avgApprovalTime = 0;
  if (approved.length > 0) {
    const totalTime = approved.reduce((sum, r) => {
      const created = new Date(r.created_at).getTime();
      const executed = new Date(r.executed_at || r.created_at).getTime();
      return sum + (executed - created);
    }, 0);
    avgApprovalTime = totalTime / approved.length / (60 * 60 * 1000); // Convert to hours
  }

  const approvalRate =
    approved.length + rejected.length > 0
      ? (approved.length / (approved.length + rejected.length)) * 100
      : 0;

  return {
    total_pending: pending.length,
    total_approved: approved.length,
    total_rejected: rejected.length,
    avg_approval_time_hours: Math.round(avgApprovalTime * 10) / 10,
    approval_rate_percent: Math.round(approvalRate),
  };
}

/**
 * Log governance event
 */
function logGovernance(
  team_id: string,
  actor_id: string,
  event_type: string,
  resource_type: string,
  resource_id: string,
  details: Record<string, unknown>,
): void {
  const log: GovernanceLog = {
    id: `log_${randomUUID()}`,
    team_id,
    event_type: event_type as any,
    actor_id,
    actor_email: `user_${actor_id}@kit.local`,
    resource_type,
    resource_id,
    details,
    timestamp: new Date().toISOString(),
  };

  governanceLogs.push(log);
}

/**
 * Get governance logs
 */
export function getGovernanceLogs(
  team_id: string,
  limit = 100,
): { logs: GovernanceLog[]; total: number } {
  const filtered = governanceLogs
    .filter((log) => log.team_id === team_id)
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, limit);

  return { logs: filtered, total: governanceLogs.filter((l) => l.team_id === team_id).length };
}
