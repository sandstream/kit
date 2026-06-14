// ─── Types ────────────────────────────────────────────────────────────────────

import { IdGenerators } from "./id-generator.js";

export interface ErrorLog {
  id: string;
  message: string;
  stack: string;
  severity: "critical" | "high" | "medium" | "low";
  context: Record<string, unknown>;
  timestamp: string;
  userId?: string;
  sessionId?: string;
  resolved: boolean;
  resolvedAt?: string;
}

export interface ErrorMetrics {
  totalErrors: number;
  errorsBySeverity: Record<string, number>;
  errorsByType: Record<string, number>;
  errorTrend: Array<{ date: string; count: number }>;
  topErrors: Array<{ message: string; count: number }>;
}

export interface ErrorGroup {
  id: string;
  message: string;
  firstSeen: string;
  lastSeen: string;
  occurrences: number;
  severity: "critical" | "high" | "medium" | "low";
  resolved: boolean;
}

// ─── ErrorTracker ────────────────────────────────────────────────────────────

export class ErrorTracker {
  private errors: Map<string, ErrorLog> = new Map();
  private errorGroups: Map<string, ErrorGroup> = new Map();
  private errorIndex: Map<string, Set<string>> = new Map(); // message → errorIds

  // ─── Error Logging ────────────────────────────────────────────────────────

  /**
   * Log an error.
   */
  logError(
    message: string,
    stack: string,
    severity: "critical" | "high" | "medium" | "low" = "high",
    context: Record<string, unknown> = {},
    userId?: string,
    sessionId?: string,
  ): ErrorLog {
    const id = IdGenerators.error();
    const error: ErrorLog = {
      id,
      message,
      stack,
      severity,
      context,
      timestamp: new Date().toISOString(),
      userId,
      sessionId,
      resolved: false,
    };

    this.errors.set(id, error);
    this.indexError(id, message);
    this.groupError(error);

    return error;
  }

  /**
   * Get error by ID.
   */
  getError(errorId: string): ErrorLog | null {
    return this.errors.get(errorId) || null;
  }

  /**
   * Resolve an error.
   */
  resolveError(errorId: string): ErrorLog | null {
    const error = this.errors.get(errorId);
    if (!error) return null;

    error.resolved = true;
    error.resolvedAt = new Date().toISOString();

    // Update error group
    const group = this.findGroupForError(error);
    if (group) {
      const unresolved = this.getErrorsByGroup(group.id).filter((e) => !e.resolved);
      if (unresolved.length === 0) {
        group.resolved = true;
      }
    }

    return error;
  }

  /**
   * Get all unresolved errors.
   */
  getUnresolvedErrors(): ErrorLog[] {
    return [...this.errors.values()].filter((e) => !e.resolved);
  }

  /**
   * Get errors by severity.
   */
  getErrorsBySeverity(severity: string): ErrorLog[] {
    return [...this.errors.values()].filter((e) => e.severity === severity && !e.resolved);
  }

  // ─── Error Grouping ───────────────────────────────────────────────────────

  private indexError(errorId: string, message: string): void {
    const ids = this.errorIndex.get(message) || new Set();
    ids.add(errorId);
    this.errorIndex.set(message, ids);
  }

  private groupError(error: ErrorLog): void {
    // Check if error message already has a group
    const existingGroup = [...this.errorGroups.values()].find(
      (g) => g.message === error.message,
    );

    if (existingGroup) {
      existingGroup.occurrences++;
      existingGroup.lastSeen = error.timestamp;
      if (error.severity === "critical" && existingGroup.severity !== "critical") {
        existingGroup.severity = "critical";
      }
    } else {
      // Create new group
      const groupId = IdGenerators.errorGroup();
      const group: ErrorGroup = {
        id: groupId,
        message: error.message,
        firstSeen: error.timestamp,
        lastSeen: error.timestamp,
        occurrences: 1,
        severity: error.severity,
        resolved: false,
      };
      this.errorGroups.set(groupId, group);
    }
  }

  private findGroupForError(error: ErrorLog): ErrorGroup | null {
    return (
      [...this.errorGroups.values()].find((g) => g.message === error.message) || null
    );
  }

  /**
   * Get all error groups.
   */
  getAllErrorGroups(): ErrorGroup[] {
    return [...this.errorGroups.values()].sort(
      (a, b) => b.occurrences - a.occurrences,
    );
  }

  /**
   * Get errors in a group.
   */
  getErrorsByGroup(groupId: string): ErrorLog[] {
    const group = this.errorGroups.get(groupId);
    if (!group) return [];

    return [...this.errors.values()].filter((e) => e.message === group.message);
  }

  // ─── Metrics & Analytics ──────────────────────────────────────────────────

  /**
   * Get error metrics.
   */
  getMetrics(): ErrorMetrics {
    const errorsBySeverity: Record<string, number> = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
    };
    const errorsByType: Record<string, number> = {};
    const errorTrend: Map<string, number> = new Map();

    for (const error of this.errors.values()) {
      errorsBySeverity[error.severity]++;

      // Count by message type
      errorsByType[error.message] = (errorsByType[error.message] || 0) + 1;

      // Count by date
      const date = error.timestamp.split("T")[0];
      errorTrend.set(date, (errorTrend.get(date) || 0) + 1);
    }

    // Get top errors
    const topErrors = Object.entries(errorsByType)
      .map(([message, count]) => ({ message, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return {
      totalErrors: this.errors.size,
      errorsBySeverity,
      errorsByType,
      errorTrend: [...errorTrend.entries()]
        .map(([date, count]) => ({ date, count }))
        .sort((a, b) => a.date.localeCompare(b.date)),
      topErrors,
    };
  }

  /**
   * Get error rate (errors per minute).
   */
  getErrorRate(): number {
    if (this.errors.size === 0) return 0;

    const now = Date.now();
    const oneMinuteAgo = now - 60 * 1000;
    const recentErrors = [...this.errors.values()].filter(
      (e) => new Date(e.timestamp).getTime() > oneMinuteAgo,
    );

    return recentErrors.length;
  }

  /**
   * Get most recent errors.
   */
  getRecentErrors(limit = 10): ErrorLog[] {
    return [...this.errors.values()]
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, limit);
  }

  // ─── Cleanup ──────────────────────────────────────────────────────────────

  /**
   * Clear old errors (older than days).
   */
  clearOldErrors(days: number): number {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    let count = 0;

    for (const [id, error] of this.errors.entries()) {
      if (new Date(error.timestamp).getTime() < cutoff) {
        this.errors.delete(id);
        count++;
      }
    }

    return count;
  }

  /**
   * Clear resolved errors.
   */
  clearResolvedErrors(): number {
    const before = this.errors.size;
    for (const [id, error] of this.errors.entries()) {
      if (error.resolved) {
        this.errors.delete(id);
      }
    }
    return before - this.errors.size;
  }

  // ─── Cache helpers ────────────────────────────────────────────────────────

  getErrorCache(): Map<string, ErrorLog> {
    return this.errors;
  }

  getErrorGroupCache(): Map<string, ErrorGroup> {
    return this.errorGroups;
  }
}
