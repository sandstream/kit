/**
 * kit MCP Tools — data models
 * Configuration, health checks, installation, and provisioning via MCP
 */

export type ConfigScope = "global" | "project" | "user";
export type ConfigCategory = "adapter" | "tool" | "service" | "path" | "feature";
export type ValidationResult = "valid" | "invalid" | "warning";

export interface ConfigValue {
  key: string;
  value: unknown;
  type: "string" | "number" | "boolean" | "array" | "object";
  scope: ConfigScope;
  category: ConfigCategory;
  description?: string;
  required?: boolean;
  default?: unknown;
  validation_rule?: string;
  last_modified?: string;
  modified_by?: string;
}

export interface ConfigValidation {
  key: string;
  result: ValidationResult;
  message: string;
  suggestions?: string[];
  timestamp: string;
}

export interface ConfigDiff {
  key: string;
  old_value: unknown;
  new_value: unknown;
  scope: ConfigScope;
  changed_at: string;
  changed_by?: string;
}

export interface AdapterConfig {
  name: string;
  enabled: boolean;
  version?: string;
  settings: Record<string, unknown>;
  credentials_configured: boolean;
  health_status?: "healthy" | "warning" | "error";
  last_check?: string;
}

export interface ToolConfig {
  name: string;
  installed: boolean;
  version?: string;
  path?: string;
  required: boolean;
  auto_update: boolean;
  health_status?: "healthy" | "missing" | "incompatible";
}

export interface ServiceConfig {
  name: string;
  enabled: boolean;
  endpoint?: string;
  port?: number;
  protocol?: "http" | "https" | "websocket" | "grpc";
  health_check_url?: string;
  status?: "running" | "stopped" | "error";
  last_status_check?: string;
}

export interface PathConfig {
  key: string;
  value: string;
  type: "project_root" | "cache_dir" | "config_dir" | "data_dir" | "temp_dir" | "lock_dir";
  expandable: boolean;
  must_exist: boolean;
  writable: boolean;
}

export interface FeatureFlag {
  name: string;
  enabled: boolean;
  scope: ConfigScope;
  rollout_percentage?: number;
  description?: string;
  dependencies?: string[];
}

export interface MCPTool {
  id: string;
  name: string;
  description: string;
  category: "configuration" | "health" | "installation" | "provisioning" | "utility";
  version: string;
  actions: ToolAction[];
  requires_auth?: boolean;
  rate_limit?: number;
}

export interface ToolAction {
  name: string;
  description: string;
  parameters: ToolParameter[];
  returns: ToolReturn;
  requires_confirmation?: boolean;
  dry_run_supported?: boolean;
}

export interface ToolParameter {
  name: string;
  description: string;
  type: "string" | "number" | "boolean" | "array" | "object";
  required: boolean;
  default?: unknown;
  enum?: unknown[];
  min?: number;
  max?: number;
  pattern?: string;
}

export interface ToolReturn {
  type: "string" | "number" | "boolean" | "object" | "array";
  description: string;
  schema?: Record<string, unknown>;
}

export interface MCPToolResult<T> {
  success: boolean;
  data?: T;
  error?: string;
  warnings?: string[];
  execution_time_ms?: number;
}

export interface ConfigSnapshot {
  id: string;
  timestamp: string;
  created_by?: string;
  config_state: Record<string, unknown>;
  description?: string;
}

export interface ConfigRollback {
  from_snapshot: string;
  to_snapshot: string;
  changes_reverted: number;
  timestamp: string;
  performed_by?: string;
}

export interface AdapterCheckResult {
  adapter_name: string;
  overall_status: "healthy" | "degraded" | "unhealthy";
  installed: boolean;
  configured: boolean;
  authenticated: boolean;
  available: boolean;
  checks: {
    name: string;
    status: "pass" | "fail" | "warning";
    message: string;
    details?: Record<string, unknown>;
  }[];
  recommendations?: string[];
  last_checked: string;
}

export interface AdapterDependency {
  name: string;
  required: boolean;
  installed: boolean;
  version?: string;
  compatible: boolean;
  min_version?: string;
}

export interface AdapterHealth {
  adapter_name: string;
  healthy: boolean;
  uptime_seconds?: number;
  last_error?: string;
  error_count: number;
  success_count: number;
  average_response_time_ms?: number;
  last_checked: string;
}

export interface AdapterInstallResult {
  adapter_name: string;
  success: boolean;
  installed: boolean;
  version?: string;
  configured: boolean;
  env_vars_set: string[];
  setup_required: boolean;
  next_steps?: string[];
  message: string;
  timestamp: string;
}

export interface AdapterSetupConfig {
  adapter_name: string;
  auto_configure: boolean;
  interactive: boolean;
  env_vars?: Record<string, string>;
  settings?: Record<string, unknown>;
}

export interface EnvironmentVariable {
  key: string;
  value: string;
  adapter_name: string;
  required: boolean;
  description?: string;
  set_at: string;
}
