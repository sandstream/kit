/**
 * Audit Logging & Compliance — data models
 * Comprehensive audit trail, activity tracking, change history, compliance reporting
 */

export type AuditAction =
  | "create"
  | "read"
  | "update"
  | "delete"
  | "execute"
  | "approve"
  | "reject"
  | "export"
  | "import"
  | "login"
  | "logout";

export type AuditResource =
  | "team"
  | "member"
  | "role"
  | "permission"
  | "plugin"
  | "workflow"
  | "integration"
  | "settings"
  | "api_key"
  | "session";

export type ComplianceStandard = "SOC2" | "GDPR" | "HIPAA" | "ISO27001" | "PCI-DSS";
export type AuditSeverity = "low" | "medium" | "high" | "critical";

export interface AuditEntry {
  id: string;
  action: AuditAction;
  resource: AuditResource;
  resource_id: string;
  actor_id: string;
  actor_name: string;
  actor_ip?: string;
  team_id?: string;
  status: "success" | "failure";
  status_code?: number;
  changes?: {
    field: string;
    old_value: unknown;
    new_value: unknown;
  }[];
  details: Record<string, unknown>;
  severity: AuditSeverity;
  timestamp: string;
  created_at: string;
}

export interface UserActivity {
  id: string;
  user_id: string;
  user_name: string;
  team_id?: string;
  action_count: number;
  last_action_at: string;
  first_action_at: string;
  login_count: number;
  last_login_at?: string;
  unique_resources_accessed: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface ChangeHistory {
  id: string;
  resource_id: string;
  resource_type: AuditResource;
  team_id?: string;
  change_type: "created" | "updated" | "deleted";
  previous_state?: Record<string, unknown>;
  current_state: Record<string, unknown>;
  changed_by: string;
  changed_by_name: string;
  reason?: string;
  timestamp: string;
  created_at: string;
}

export interface ComplianceReport {
  id: string;
  standard: ComplianceStandard;
  period_start: string;
  period_end: string;
  team_id?: string;
  total_audit_entries: number;
  security_events: number;
  failed_operations: number;
  data_access_events: number;
  deletion_events: number;
  role_changes: number;
  permission_changes: number;
  compliance_score: number; // 0-100
  issues: ComplianceIssue[];
  generated_at: string;
  generated_by: string;
  created_at: string;
}

export interface ComplianceIssue {
  id: string;
  severity: AuditSeverity;
  type: string; // "unauthorized_access", "data_deletion", "role_elevation", etc.
  description: string;
  resource_id?: string;
  resource_type?: AuditResource;
  actor_id?: string;
  timestamp: string;
  remediation?: string;
}

export interface AuditLog {
  id: string;
  team_id?: string;
  action: AuditAction;
  resource: AuditResource;
  resource_id: string;
  actor_id: string;
  actor_name: string;
  status: "success" | "failure";
  severity: AuditSeverity;
  details: Record<string, unknown>;
  timestamp: string;
  created_at: string;
}

export interface AuditQuery {
  team_id?: string;
  actor_id?: string;
  resource?: AuditResource;
  action?: AuditAction;
  status?: "success" | "failure";
  severity?: AuditSeverity;
  start_date?: string;
  end_date?: string;
  limit?: number;
  offset?: number;
}

export interface AuditMetrics {
  total_entries: number;
  entries_last_24h: number;
  entries_last_7d: number;
  entries_last_30d: number;
  unique_users: number;
  unique_resources: number;
  failed_operations_count: number;
  critical_events_count: number;
  average_actions_per_user: number;
  most_common_action: string;
  most_accessed_resource: string;
}

export interface DataExportRequest {
  id: string;
  user_id: string;
  team_id?: string;
  export_type: "full" | "filtered";
  data_types: AuditResource[];
  start_date?: string;
  end_date?: string;
  format: "json" | "csv" | "parquet";
  status: "pending" | "processing" | "completed" | "failed";
  download_url?: string;
  expires_at?: string;
  requested_at: string;
  completed_at?: string;
  created_at: string;
}

export interface SessionAudit {
  id: string;
  user_id: string;
  session_id: string;
  ip_address: string;
  user_agent: string;
  login_time: string;
  logout_time?: string;
  duration_minutes?: number;
  actions_count: number;
  last_activity_at: string;
  is_active: boolean;
  created_at: string;
}
