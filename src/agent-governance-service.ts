import { randomUUID } from "node:crypto";
import type {
  GovernancePolicy,
  AgentPermission,
  AgentSecurityProfile,
  GovernanceAuditLog,
  RateLimitPolicy,
  ResourceQuota,
  GovernanceMetrics,
  PolicyEvaluation,
  PolicyType,
  ActionType,
  PermissionLevel,
} from "./agent-governance-model.js";

const policies = new Map<string, GovernancePolicy>();
const permissions = new Map<string, AgentPermission>();
const securityProfiles = new Map<string, AgentSecurityProfile>();
const auditLogs = new Map<string, GovernanceAuditLog>();
const rateLimits = new Map<string, RateLimitPolicy>();
const quotas = new Map<string, ResourceQuota>();
const evaluations = new Map<string, PolicyEvaluation>();

/**
 * Create governance policy
 */
export function createGovernancePolicy(
  team_id: string,
  policy_name: string,
  policy_type: PolicyType,
  created_by: string,
  description?: string,
): { policy: GovernancePolicy; error?: string } {
  const policy: GovernancePolicy = {
    id: `policy_${randomUUID()}`,
    team_id,
    policy_name,
    description: description || "",
    policy_type,
    status: "draft",
    rules: [],
    priority: 50,
    enforcement_enabled: false,
    created_by,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  policies.set(policy.id, policy);
  return { policy };
}

/**
 * Add rule to policy
 */
export function addPolicyRule(
  team_id: string,
  policy_id: string,
  condition: string,
  action: string,
  consequence?: string,
): { policy: GovernancePolicy; error?: string } {
  const policy = policies.get(policy_id);
  if (!policy || policy.team_id !== team_id) {
    return { policy: {} as GovernancePolicy, error: "Policy not found" };
  }

  policy.rules.push({ condition, action, consequence });
  policy.updated_at = new Date().toISOString();

  return { policy };
}

/**
 * Activate policy
 */
export function activatePolicy(
  team_id: string,
  policy_id: string,
): { policy: GovernancePolicy; error?: string } {
  const policy = policies.get(policy_id);
  if (!policy || policy.team_id !== team_id) {
    return { policy: {} as GovernancePolicy, error: "Policy not found" };
  }

  if (policy.rules.length === 0) {
    return { policy: {} as GovernancePolicy, error: "Policy has no rules" };
  }

  policy.status = "active";
  policy.enforcement_enabled = true;
  policy.updated_at = new Date().toISOString();

  return { policy };
}

/**
 * Create security profile for agent
 */
export function createSecurityProfile(
  team_id: string,
  agent_id: string,
  agent_type: string,
): { profile: AgentSecurityProfile; error?: string } {
  const profile: AgentSecurityProfile = {
    id: `profile_${randomUUID()}`,
    team_id,
    agent_id,
    agent_type,
    risk_level: "medium",
    trust_score: 50,
    permissions: [],
    violations_count: 0,
    sandboxed: false,
    resource_limits: {
      max_concurrent_workflows: 5,
      max_api_calls_per_hour: 1000,
      max_memory_mb: 512,
      max_storage_gb: 10,
    },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  securityProfiles.set(profile.id, profile);
  return { profile };
}

/**
 * Grant permission to agent
 */
export function grantPermission(
  team_id: string,
  agent_id: string,
  resource_type: string,
  action: ActionType,
  permission_level: PermissionLevel,
  granted_by: string,
  resource_id?: string,
  expires_at?: string,
): { permission: AgentPermission; error?: string } {
  const permission: AgentPermission = {
    id: `perm_${randomUUID()}`,
    team_id,
    agent_id,
    resource_type,
    resource_id,
    action,
    permission_level,
    granted_by,
    granted_at: new Date().toISOString(),
    expires_at,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  permissions.set(permission.id, permission);

  // Update security profile
  const profiles = Array.from(securityProfiles.values()).filter(
    (p) => p.team_id === team_id && p.agent_id === agent_id,
  );
  if (profiles.length > 0) {
    profiles[0].permissions.push(permission);
  }

  return { permission };
}

/**
 * Revoke permission
 */
export function revokePermission(
  team_id: string,
  permission_id: string,
): { success: boolean; error?: string } {
  const permission = permissions.get(permission_id);
  if (!permission || permission.team_id !== team_id) {
    return { success: false, error: "Permission not found" };
  }

  permissions.delete(permission_id);

  // Update security profile
  const profiles = Array.from(securityProfiles.values()).filter(
    (p) => p.team_id === team_id && p.agent_id === permission.agent_id,
  );
  if (profiles.length > 0) {
    profiles[0].permissions = profiles[0].permissions.filter((p) => p.id !== permission_id);
  }

  return { success: true };
}

/**
 * Evaluate policy for agent action
 */
export function evaluatePolicy(
  team_id: string,
  policy_id: string,
  agent_id: string,
  action: ActionType,
  resource_type: string,
  resource_id?: string,
): { evaluation: PolicyEvaluation; error?: string } {
  const policy = policies.get(policy_id);
  if (!policy || policy.team_id !== team_id) {
    return { evaluation: {} as PolicyEvaluation, error: "Policy not found" };
  }

  if (!policy.enforcement_enabled) {
    return { evaluation: {} as PolicyEvaluation, error: "Policy not active" };
  }

  // Check if agent is in target list
  if (policy.target_agents && !policy.target_agents.includes(agent_id) && !policy.target_agents.includes("*")) {
    return { evaluation: {} as PolicyEvaluation, error: "Agent not subject to policy" };
  }

  // Evaluate rules (check if any rule applies)
  let allowed = true;
  const matchedRules = policy.rules.filter((r) => r.action.includes(action) || r.action === "allow");
  if (matchedRules.length > 0) {
    const denialRule = matchedRules.find((r) => r.consequence === "deny");
    allowed = !denialRule;
  } else {
    // Default to allow if no specific rules match
    allowed = true;
  }

  const evaluation: PolicyEvaluation = {
    id: `eval_${randomUUID()}`,
    team_id,
    policy_id,
    agent_id,
    action,
    resource_type,
    allowed,
    reason: allowed ? "Policy allowed action" : "Policy denied action",
    timestamp: new Date().toISOString(),
    created_at: new Date().toISOString(),
  };

  evaluations.set(evaluation.id, evaluation);

  // Log to audit
  logAuditEvent(
    team_id,
    agent_id,
    allowed ? "allowed" : "denied",
    action,
    resource_type,
    resource_id,
    policy_id,
  );

  return { evaluation };
}

/**
 * Log audit event
 */
export function logAuditEvent(
  team_id: string,
  agent_id: string | undefined,
  status: "allowed" | "denied" | "warning",
  action: ActionType,
  resource_type: string,
  resource_id?: string,
  policy_id?: string,
): { log: GovernanceAuditLog } {
  const log: GovernanceAuditLog = {
    id: `audit_${randomUUID()}`,
    team_id,
    agent_id,
    action: action as any,
    resource_type,
    resource_id,
    details: {},
    severity: status === "denied" ? "critical" : "info",
    status,
    policy_evaluated: policy_id,
    timestamp: new Date().toISOString(),
    created_at: new Date().toISOString(),
  };

  auditLogs.set(log.id, log);

  // Update security profile violation count if denied
  if (status === "denied" && agent_id) {
    const profiles = Array.from(securityProfiles.values()).filter(
      (p) => p.team_id === team_id && p.agent_id === agent_id,
    );
    if (profiles.length > 0) {
      profiles[0].violations_count += 1;
      profiles[0].last_violation = new Date().toISOString();
    }
  }

  return { log };
}

/**
 * Set rate limit for agent
 */
export function setRateLimit(
  team_id: string,
  agent_id: string | undefined,
  resource_type: string,
  requests_per_minute: number,
  requests_per_hour: number,
): { rateLimit: RateLimitPolicy; error?: string } {
  const rateLimit: RateLimitPolicy = {
    id: `ratelimit_${randomUUID()}`,
    team_id,
    agent_id,
    resource_type,
    requests_per_minute,
    requests_per_hour,
    requests_per_day: requests_per_hour * 24,
    burst_limit: Math.ceil(requests_per_minute * 1.5),
    enabled: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  rateLimits.set(rateLimit.id, rateLimit);
  return { rateLimit };
}

/**
 * Set resource quota for agent
 */
export function setResourceQuota(
  team_id: string,
  agent_id: string | undefined,
  resource_type: string,
  limit: number,
  unit: string,
  period: "hour" | "day" | "month",
): { quota: ResourceQuota; error?: string } {
  const quota: ResourceQuota = {
    id: `quota_${randomUUID()}`,
    team_id,
    agent_id,
    resource_type,
    limit,
    unit,
    period,
    current_usage: 0,
    warning_threshold_percent: 80,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  quotas.set(quota.id, quota);
  return { quota };
}

/**
 * Get security profile
 */
export function getSecurityProfile(
  team_id: string,
  agent_id: string,
): { profile: AgentSecurityProfile | null; error?: string } {
  const profiles = Array.from(securityProfiles.values()).filter(
    (p) => p.team_id === team_id && p.agent_id === agent_id,
  );

  if (profiles.length === 0) {
    return { profile: null, error: "Security profile not found" };
  }

  return { profile: profiles[0] };
}

/**
 * Get audit logs for period
 */
export function getAuditLogs(
  team_id: string,
  agent_id?: string,
  limit: number = 100,
  offset: number = 0,
): { logs: GovernanceAuditLog[]; total: number } {
  let filtered = Array.from(auditLogs.values()).filter((log) => log.team_id === team_id);

  if (agent_id) {
    filtered = filtered.filter((log) => log.agent_id === agent_id);
  }

  // Sort by timestamp descending
  filtered.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  const results = filtered.slice(offset, offset + limit);
  return { logs: results, total: filtered.length };
}

/**
 * Get governance metrics
 */
export function getGovernanceMetrics(team_id: string): GovernanceMetrics {
  const teamPolicies = Array.from(policies.values()).filter((p) => p.team_id === team_id);
  const activePolicies = teamPolicies.filter((p) => p.status === "active").length;

  const teamPermissions = Array.from(permissions.values()).filter((p) => p.team_id === team_id);

  const teamProfiles = Array.from(securityProfiles.values()).filter((p) => p.team_id === team_id);
  const profilesWithViolations = teamProfiles.filter((p) => p.violations_count > 0).length;
  const avgTrust =
    teamProfiles.length > 0
      ? teamProfiles.reduce((sum, p) => sum + p.trust_score, 0) / teamProfiles.length
      : 0;

  const teamLogs = Array.from(auditLogs.values()).filter((log) => log.team_id === team_id);
  const criticalLogs = teamLogs.filter((log) => log.severity === "critical").length;
  const deniedLogs = teamLogs.filter((log) => log.status === "denied").length;
  const violationRate = teamLogs.length > 0 ? (deniedLogs / teamLogs.length) * 100 : 0;

  return {
    total_policies: teamPolicies.length,
    active_policies: activePolicies,
    total_permissions: teamPermissions.length,
    agents_with_violations: profilesWithViolations,
    total_audit_events: teamLogs.length,
    critical_events_count: criticalLogs,
    average_trust_score: avgTrust,
    policy_violation_rate_percent: violationRate,
    average_response_time_ms: 45,
  };
}

/**
 * Update agent trust score
 */
export function updateTrustScore(
  team_id: string,
  agent_id: string,
  score_adjustment: number,
): { profile: AgentSecurityProfile; error?: string } {
  const profiles = Array.from(securityProfiles.values()).filter(
    (p) => p.team_id === team_id && p.agent_id === agent_id,
  );

  if (profiles.length === 0) {
    return { profile: {} as AgentSecurityProfile, error: "Security profile not found" };
  }

  const profile = profiles[0];
  profile.trust_score = Math.max(0, Math.min(100, profile.trust_score + score_adjustment));
  profile.updated_at = new Date().toISOString();

  // Adjust risk level based on trust score
  if (profile.trust_score >= 80) {
    profile.risk_level = "low";
  } else if (profile.trust_score >= 50) {
    profile.risk_level = "medium";
  } else {
    profile.risk_level = "high";
  }

  return { profile };
}

/**
 * List all policies
 */
export function listPolicies(team_id: string): { policies: GovernancePolicy[] } {
  const teamPolicies = Array.from(policies.values()).filter((p) => p.team_id === team_id);
  return { policies: teamPolicies };
}
