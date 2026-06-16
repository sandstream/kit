import { randomUUID } from "node:crypto";
import type {
  AuditEntry,
  UserActivity,
  ChangeHistory,
  ComplianceReport,
  ComplianceIssue,
  AuditLog,
  AuditQuery,
  AuditMetrics,
  DataExportRequest,
  SessionAudit,
  AuditAction,
  AuditResource,
  AuditSeverity,
  ComplianceStandard,
} from "./audit-logging-model.js";

const auditEntries = new Map<string, AuditEntry>();
const userActivity = new Map<string, UserActivity>();
const changeHistory = new Map<string, ChangeHistory>();
const complianceReports = new Map<string, ComplianceReport>();
const auditLogs = new Map<string, AuditLog>();
const dataExports = new Map<string, DataExportRequest>();
const sessionAudits = new Map<string, SessionAudit>();

/**
 * Record audit entry
 */
export function recordAuditEntry(
  action: AuditAction,
  resource: AuditResource,
  resource_id: string,
  actor_id: string,
  actor_name: string,
  status: "success" | "failure" = "success",
  details: Record<string, unknown> = {},
  severity: AuditSeverity = "low",
  team_id?: string,
  actor_ip?: string,
): { entry: AuditEntry; error?: string } {
  const entry: AuditEntry = {
    id: `audit_${randomUUID()}`,
    action,
    resource,
    resource_id,
    actor_id,
    actor_name,
    actor_ip,
    team_id,
    status,
    details,
    severity,
    timestamp: new Date().toISOString(),
    created_at: new Date().toISOString(),
  };

  auditEntries.set(entry.id, entry);

  // Update user activity
  updateUserActivity(actor_id, actor_name, team_id);

  // Create audit log entry
  const log: AuditLog = {
    id: `log_${randomUUID()}`,
    team_id,
    action,
    resource,
    resource_id,
    actor_id,
    actor_name,
    status,
    severity,
    details,
    timestamp: entry.timestamp,
    created_at: entry.created_at,
  };

  auditLogs.set(log.id, log);

  return { entry };
}

/**
 * Record change history
 */
export function recordChangeHistory(
  resource_id: string,
  resource_type: AuditResource,
  change_type: "created" | "updated" | "deleted",
  current_state: Record<string, unknown>,
  changed_by: string,
  changed_by_name: string,
  previous_state?: Record<string, unknown>,
  reason?: string,
  team_id?: string,
): { history: ChangeHistory; error?: string } {
  const history: ChangeHistory = {
    id: `hist_${randomUUID()}`,
    resource_id,
    resource_type,
    team_id,
    change_type,
    current_state,
    previous_state,
    changed_by,
    changed_by_name,
    reason,
    timestamp: new Date().toISOString(),
    created_at: new Date().toISOString(),
  };

  changeHistory.set(history.id, history);

  return { history };
}

/**
 * Query audit entries
 */
export function queryAuditEntries(
  query: AuditQuery,
): { entries: AuditEntry[]; total: number } {
  let results = Array.from(auditEntries.values());

  if (query.team_id) {
    results = results.filter((e) => e.team_id === query.team_id);
  }

  if (query.actor_id) {
    results = results.filter((e) => e.actor_id === query.actor_id);
  }

  if (query.resource) {
    results = results.filter((e) => e.resource === query.resource);
  }

  if (query.action) {
    results = results.filter((e) => e.action === query.action);
  }

  if (query.status) {
    results = results.filter((e) => e.status === query.status);
  }

  if (query.severity) {
    results = results.filter((e) => e.severity === query.severity);
  }

  if (query.start_date) {
    const startDate = new Date(query.start_date);
    results = results.filter((e) => new Date(e.timestamp) >= startDate);
  }

  if (query.end_date) {
    const endDate = new Date(query.end_date);
    results = results.filter((e) => new Date(e.timestamp) <= endDate);
  }

  // Sort by timestamp descending
  results.sort(
    (a, b) =>
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );

  const limit = query.limit || 100;
  const offset = query.offset || 0;
  const total = results.length;

  return { entries: results.slice(offset, offset + limit), total };
}

/**
 * Get user activity
 */
export function getUserActivity(user_id: string): { activity: UserActivity | null; error?: string } {
  const activity = userActivity.get(user_id);
  return {
    activity: activity || null,
    error: activity ? undefined : "User activity not found",
  };
}

/**
 * List user activities
 */
export function listUserActivities(
  team_id?: string,
  limit: number = 50,
  offset: number = 0,
): { activities: UserActivity[]; total: number } {
  let all = Array.from(userActivity.values());

  if (team_id) {
    all = all.filter((a) => a.team_id === team_id);
  }

  all.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());

  const total = all.length;
  return { activities: all.slice(offset, offset + limit), total };
}

/**
 * Get change history for resource
 */
export function getChangeHistory(
  resource_id: string,
  limit: number = 50,
  offset: number = 0,
): { history: ChangeHistory[]; total: number } {
  const all = Array.from(changeHistory.values()).filter((h) => h.resource_id === resource_id);

  all.sort(
    (a, b) =>
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );

  const total = all.length;
  return { history: all.slice(offset, offset + limit), total };
}

/**
 * Generate compliance report
 */
export function generateComplianceReport(
  standard: ComplianceStandard,
  period_start: string,
  period_end: string,
  generated_by: string,
  team_id?: string,
): { report: ComplianceReport; error?: string } {
  const startDate = new Date(period_start);
  const endDate = new Date(period_end);

  const entries = Array.from(auditEntries.values()).filter((e) => {
    const timestamp = new Date(e.timestamp);
    const teamMatch = !team_id || e.team_id === team_id;
    const dateMatch = timestamp >= startDate && timestamp <= endDate;
    return teamMatch && dateMatch;
  });

  const issues: ComplianceIssue[] = [];

  // Identify compliance issues
  const failedOps = entries.filter((e) => e.status === "failure");
  failedOps.forEach((e) => {
    if (failedOps.length > 10) {
      // Threshold for concern
      issues.push({
        id: `issue_${randomUUID()}`,
        severity: "medium",
        type: "high_failure_rate",
        description: `High rate of failed operations detected (${failedOps.length} in period)`,
        timestamp: new Date().toISOString(),
      });
    }
  });

  const criticalEvents = entries.filter((e) => e.severity === "critical");
  if (criticalEvents.length > 0) {
    criticalEvents.forEach((e) => {
      issues.push({
        id: `issue_${randomUUID()}`,
        severity: "critical",
        type: "critical_event",
        description: `Critical event: ${e.action} on ${e.resource}`,
        resource_id: e.resource_id,
        resource_type: e.resource,
        actor_id: e.actor_id,
        timestamp: e.timestamp,
      });
    });
  }

  // Calculate compliance score
  let score = 100;
  score -= failedOps.length * 2;
  score -= criticalEvents.length * 10;
  score = Math.max(0, Math.min(100, score));

  const report: ComplianceReport = {
    id: `report_${randomUUID()}`,
    standard,
    period_start,
    period_end,
    team_id,
    total_audit_entries: entries.length,
    security_events: entries.filter((e) => e.severity === "critical" || e.severity === "high")
      .length,
    failed_operations: failedOps.length,
    data_access_events: entries.filter(
      (e) =>
        e.action === "read" ||
        e.action === "export" ||
        e.action === "import",
    ).length,
    deletion_events: entries.filter((e) => e.action === "delete").length,
    role_changes: entries.filter(
      (e) => e.resource === "role" && e.action === "update",
    ).length,
    permission_changes: entries.filter(
      (e) => e.resource === "permission",
    ).length,
    compliance_score: score,
    issues,
    generated_at: new Date().toISOString(),
    generated_by,
    created_at: new Date().toISOString(),
  };

  complianceReports.set(report.id, report);

  return { report };
}

/**
 * List compliance reports
 */
export function listComplianceReports(
  team_id?: string,
  limit: number = 50,
  offset: number = 0,
): { reports: ComplianceReport[]; total: number } {
  let all = Array.from(complianceReports.values());

  if (team_id) {
    all = all.filter((r) => r.team_id === team_id);
  }

  all.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  const total = all.length;
  return { reports: all.slice(offset, offset + limit), total };
}

/**
 * Request data export for compliance
 */
export function requestDataExport(
  user_id: string,
  format: "json" | "csv" | "parquet",
  data_types: AuditResource[],
  team_id?: string,
  start_date?: string,
  end_date?: string,
): { request: DataExportRequest; error?: string } {
  const request: DataExportRequest = {
    id: `export_${randomUUID()}`,
    user_id,
    team_id,
    export_type: "filtered",
    data_types,
    start_date,
    end_date,
    format,
    status: "pending",
    requested_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
  };

  dataExports.set(request.id, request);

  // Simulate processing (in real system would be async)
  setTimeout(() => {
    const exp = dataExports.get(request.id);
    if (exp) {
      exp.status = "completed";
      exp.download_url = `https://api.example.com/exports/${request.id}`;
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7);
      exp.expires_at = expiresAt.toISOString();
      exp.completed_at = new Date().toISOString();
    }
  }, 1000);

  return { request };
}

/**
 * Get data export status
 */
export function getDataExportStatus(export_id: string): { request: DataExportRequest | null; error?: string } {
  const request = dataExports.get(export_id);
  return {
    request: request || null,
    error: request ? undefined : "Export request not found",
  };
}

/**
 * Record session audit
 */
export function recordSessionAudit(
  user_id: string,
  session_id: string,
  ip_address: string,
  user_agent: string,
): { session: SessionAudit; error?: string } {
  const session: SessionAudit = {
    id: `session_${randomUUID()}`,
    user_id,
    session_id,
    ip_address,
    user_agent,
    login_time: new Date().toISOString(),
    actions_count: 0,
    last_activity_at: new Date().toISOString(),
    is_active: true,
    created_at: new Date().toISOString(),
  };

  sessionAudits.set(session.id, session);

  return { session };
}

/**
 * End session audit
 */
export function endSessionAudit(session_id: string): { success: boolean; error?: string } {
  const session = Array.from(sessionAudits.values()).find((s) => s.session_id === session_id);
  if (!session) {
    return { success: false, error: "Session not found" };
  }

  session.is_active = false;
  session.logout_time = new Date().toISOString();
  session.duration_minutes = Math.round(
    (new Date(session.logout_time).getTime() - new Date(session.login_time).getTime()) /
      60000,
  );

  return { success: true };
}

/**
 * Get audit metrics
 */
export function getAuditMetrics(team_id?: string): AuditMetrics {
  const now = new Date();
  const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const last7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const last30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  let entries = Array.from(auditEntries.values());
  if (team_id) {
    entries = entries.filter((e) => e.team_id === team_id);
  }

  const entries24h = entries.filter((e) => new Date(e.timestamp) >= last24h).length;
  const entries7d = entries.filter((e) => new Date(e.timestamp) >= last7d).length;
  const entries30d = entries.filter((e) => new Date(e.timestamp) >= last30d).length;

  const uniqueUsers = new Set(entries.map((e) => e.actor_id)).size;
  const uniqueResources = new Set(entries.map((e) => e.resource_id)).size;
  const failedOps = entries.filter((e) => e.status === "failure").length;
  const criticalEvents = entries.filter((e) => e.severity === "critical").length;

  const actionCounts: Record<string, number> = {};
  const resourceCounts: Record<string, number> = {};

  entries.forEach((e) => {
    actionCounts[e.action] = (actionCounts[e.action] || 0) + 1;
    resourceCounts[e.resource] = (resourceCounts[e.resource] || 0) + 1;
  });

  const mostCommonAction = Object.entries(actionCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || "none";
  const mostAccessedResource = Object.entries(resourceCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || "none";

  return {
    total_entries: entries.length,
    entries_last_24h: entries24h,
    entries_last_7d: entries7d,
    entries_last_30d: entries30d,
    unique_users: uniqueUsers,
    unique_resources: uniqueResources,
    failed_operations_count: failedOps,
    critical_events_count: criticalEvents,
    average_actions_per_user: uniqueUsers > 0 ? Math.round(entries.length / uniqueUsers) : 0,
    most_common_action: mostCommonAction,
    most_accessed_resource: mostAccessedResource,
  };
}

/**
 * Update user activity (internal)
 */
function updateUserActivity(user_id: string, user_name: string, team_id?: string): void {
  const existing = userActivity.get(user_id);

  if (existing) {
    existing.action_count += 1;
    existing.last_action_at = new Date().toISOString();
    existing.updated_at = new Date().toISOString();
  } else {
    const activity: UserActivity = {
      id: `activity_${randomUUID()}`,
      user_id,
      user_name,
      team_id,
      action_count: 1,
      first_action_at: new Date().toISOString(),
      last_action_at: new Date().toISOString(),
      login_count: 0,
      unique_resources_accessed: 1,
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    userActivity.set(user_id, activity);
  }
}
