/**
 * Agent Governance & Security Framework — data models
 * Governance controls, permission systems, audit logging, and security policies
 */

export type PolicyType = "access_control" | "rate_limit" | "resource_quota" | "behavior_restriction";
export type PolicyStatus = "draft" | "active" | "paused" | "deprecated";
export type ActionType = "create" | "read" | "update" | "delete" | "execute" | "approve";
export type PermissionLevel = "none" | "viewer" | "editor" | "admin" | "owner";
export type AuditAction =
  | "agent_created"
  | "agent_modified"
  | "permission_granted"
  | "permission_revoked"
  | "workflow_executed"
  | "policy_violated"
  | "secret_accessed"
  | "resource_used";

export interface GovernancePolicy {
  id: string;
  team_id: string;
  policy_name: string;
  description: string;
  policy_type: PolicyType;
  status: PolicyStatus;
  rules: {
    condition: string;
    action: string;
    consequence?: string;
  }[];
  target_agents?: string[]; // Specific agent IDs or "*" for all
  target_workflows?: string[]; // Specific workflow IDs or "*" for all
  priority: number; // 1-100, higher = more important
  enforcement_enabled: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface AgentPermission {
  id: string;
  team_id: string;
  agent_id: string;
  resource_type: string; // "workflow", "secret", "plugin", "infrastructure"
  resource_id?: string; // Specific resource or "*" for all
  action: ActionType;
  permission_level: PermissionLevel;
  granted_by: string;
  granted_at: string;
  expires_at?: string;
  conditions?: Record<string, unknown>; // Time, location, etc.
  created_at: string;
  updated_at: string;
}

export interface AgentSecurityProfile {
  id: string;
  team_id: string;
  agent_id: string;
  agent_type: string; // claude, cursor, cline
  risk_level: "low" | "medium" | "high";
  trust_score: number; // 0-100
  permissions: AgentPermission[];
  violations_count: number;
  last_violation?: string;
  sandboxed: boolean;
  resource_limits: {
    max_concurrent_workflows: number;
    max_api_calls_per_hour: number;
    max_memory_mb: number;
    max_storage_gb: number;
  };
  created_at: string;
  updated_at: string;
}

export interface GovernanceAuditLog {
  id: string;
  team_id: string;
  agent_id?: string;
  action: AuditAction;
  resource_type: string;
  resource_id?: string;
  details: Record<string, unknown>;
  severity: "info" | "warning" | "critical";
  status: "allowed" | "denied" | "warning";
  policy_evaluated?: string; // Policy ID that was applied
  timestamp: string;
  created_at: string;
}

export interface RateLimitPolicy {
  id: string;
  team_id: string;
  agent_id?: string; // Specific agent or undefined for team-wide
  resource_type: string;
  requests_per_minute: number;
  requests_per_hour: number;
  requests_per_day: number;
  burst_limit: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface ResourceQuota {
  id: string;
  team_id: string;
  agent_id?: string;
  resource_type: string; // "api_calls", "storage", "compute", "bandwidth"
  limit: number;
  unit: string; // "calls", "gb", "cpu_hours", "mbps"
  period: "hour" | "day" | "month";
  current_usage: number;
  warning_threshold_percent: number; // Alert at this percentage
  created_at: string;
  updated_at: string;
}

export interface GovernanceMetrics {
  total_policies: number;
  active_policies: number;
  total_permissions: number;
  agents_with_violations: number;
  total_audit_events: number;
  critical_events_count: number;
  average_trust_score: number;
  policy_violation_rate_percent: number;
  average_response_time_ms: number;
}

export interface PolicyEvaluation {
  id: string;
  team_id: string;
  policy_id: string;
  agent_id: string;
  action: ActionType;
  resource_type: string;
  allowed: boolean;
  reason: string;
  violated_rules?: string[];
  timestamp: string;
  created_at: string;
}
