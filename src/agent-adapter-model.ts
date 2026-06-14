/**
 * Agent-Specific Adapters — data models
 * Adapters for Claude, Cursor, Cline with introspection, automation, collaboration
 */

export type AgentType = "claude" | "cursor" | "cline" | "generic";
export type AdapterStatus = "unknown" | "not_installed" | "installed" | "configured" | "active";
export type CapabilityType =
  | "file_read"
  | "file_write"
  | "code_execution"
  | "terminal_access"
  | "git_integration"
  | "debugging"
  | "testing"
  | "ai_collaboration"
  | "workspace_awareness"
  | "context_management";
export type CollaborationMode = "sequential" | "parallel" | "competitive" | "hierarchical";

export interface AgentProfile {
  id: string;
  agent_type: AgentType;
  version: string;
  name: string;
  description?: string;
  capabilities: CapabilityType[];
  config_required: string[]; // Required config keys
  optional_config: string[];
  installation_method: "npm" | "manual" | "extension" | "cli";
  homepage?: string;
  documentation?: string;
  created_at: string;
  updated_at: string;
}

export interface AgentAdapter {
  id: string;
  team_id: string;
  agent_type: AgentType;
  agent_profile_id: string;
  status: AdapterStatus;
  version: string;
  installed_at?: string;
  configured_at?: string;
  config: Record<string, string | number | boolean>;
  enabled_capabilities: CapabilityType[];
  disabled_capabilities: CapabilityType[];
  health_status: "healthy" | "degraded" | "error";
  last_health_check?: string;
  created_at: string;
  updated_at: string;
}

export interface AgentCapability {
  id: string;
  adapter_id: string;
  team_id: string;
  capability_type: CapabilityType;
  enabled: boolean;
  required_config: Record<string, unknown>;
  permissions_required: string[];
  rate_limit?: number; // Operations per minute
  timeout_ms?: number;
  last_used?: string;
  usage_count: number;
  created_at: string;
  updated_at: string;
}

export interface AgentIntrospection {
  id: string;
  team_id: string;
  adapter_id: string;
  introspection_type: "capabilities" | "context" | "state" | "performance" | "health";
  data: Record<string, unknown>;
  timestamp: string;
  ttl_seconds: number;
}

export interface AgentAutomation {
  id: string;
  team_id: string;
  adapter_id: string;
  automation_name: string;
  description?: string;
  trigger: string; // Event or schedule
  actions: string[]; // Actions to execute
  enabled: boolean;
  run_count: number;
  last_run?: string;
  error_count: number;
  created_at: string;
  updated_at: string;
}

export interface AgentCollaboration {
  id: string;
  team_id: string;
  collaboration_id: string;
  agents: {
    adapter_id: string;
    agent_type: AgentType;
    role: "primary" | "secondary" | "observer";
  }[];
  mode: CollaborationMode;
  shared_context: Record<string, unknown>;
  status: "active" | "paused" | "completed" | "failed";
  created_at: string;
  updated_at: string;
  completed_at?: string;
}

export interface AgentMetrics {
  adapter_id: string;
  agent_type: AgentType;
  health_score: number; // 0-100
  uptime_percent: number;
  capability_coverage: number; // Enabled capabilities / total available
  average_latency_ms: number;
  error_rate_percent: number;
  last_activity: string;
  collaborations_active: number;
  automations_active: number;
  operations_today: number;
}
