// ─── Types ────────────────────────────────────────────────────────────────────

import { IdGenerators } from "./id-generator.js";

export type ContentType = "plugin" | "review" | "comment" | "author";
export type ViolationType =
  | "spam"
  | "abuse"
  | "misleading"
  | "copyright"
  | "malware"
  | "other";
export type ModerationStatus = "pending" | "approved" | "rejected" | "appealed" | "resolved";
export type AppealStatus = "pending" | "upheld" | "overturned" | "closed";

export interface ContentItem {
  id: string;
  type: ContentType;
  pluginId?: string;
  reviewId?: string;
  commentId?: string;
  authorId: string;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface ModerationReport {
  id: string;
  contentId: string;
  contentType: ContentType;
  reportedBy: string;
  reason: ViolationType;
  description: string;
  evidence: string[];
  status: ModerationStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ModerationAction {
  id: string;
  reportId: string;
  contentId: string;
  action: "warning" | "suspend_comment" | "unpublish" | "suspend_user" | "ban_user";
  reason: string;
  duration?: number; // in days, null = permanent
  appliedBy: string;
  appliedAt: string;
  metadata: Record<string, unknown>;
}

export interface Appeal {
  id: string;
  actionId: string;
  reportId: string;
  contentId: string;
  appealedBy: string;
  reason: string;
  evidence: string[];
  status: AppealStatus;
  reviewedBy?: string;
  reviewedAt?: string;
  decision?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ModerationQueue {
  reportId: string;
  contentId: string;
  contentType: ContentType;
  reportCount: number;
  priority: "low" | "medium" | "high" | "critical";
  createdAt: string;
  reason?: string;
}

export interface SpamSignals {
  hasMultipleReports: boolean;
  hasAbusiveLanguage: boolean;
  hasExcessiveLinks: boolean;
  hasSuspiciousPatterns: boolean;
  isNewAccount: boolean; // created < 7 days ago
  score: number; // 0-100
}

export interface ModerationStats {
  totalReports: number;
  approvedCount: number;
  rejectedCount: number;
  pendingCount: number;
  appealsCount: number;
  suspensionsCount: number;
  bansCount: number;
  averageResolutionTimeMs: number;
}

export interface CommunityGuideline {
  id: string;
  title: string;
  description: string;
  examples: string[];
  consequenceLevel: "warning" | "suspension" | "ban";
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

// ─── ModerationSystem ─────────────────────────────────────────────────────────

export class ModerationSystem {
  private reports: Map<string, ModerationReport> = new Map();
  private actions: Map<string, ModerationAction> = new Map();
  private appeals: Map<string, Appeal> = new Map();
  private suspendedUsers: Map<string, { until: Date; reason: string }> = new Map();
  private bannedUsers: Set<string> = new Set();
  private guidelines: Map<string, CommunityGuideline> = new Map();
  private reportQueue: ModerationQueue[] = [];

  // ─── Reporting & Flagging ─────────────────────────────────────────────────

  /**
   * File a moderation report against content (plugin, review, comment, author).
   */
  fileReport(
    contentId: string,
    contentType: ContentType,
    reportedBy: string,
    reason: ViolationType,
    description: string,
    evidence: string[] = [],
  ): ModerationReport {
    const reportId = IdGenerators.report();
    const report: ModerationReport = {
      id: reportId,
      contentId,
      contentType,
      reportedBy,
      reason,
      description,
      evidence,
      status: "pending",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.reports.set(reportId, report);

    // Add to moderation queue
    this.updateQueue(contentId, contentType, reportedBy);

    return report;
  }

  getReport(reportId: string): ModerationReport | null {
    return this.reports.get(reportId) || null;
  }

  getContentReports(contentId: string): ModerationReport[] {
    return [...this.reports.values()].filter((r) => r.contentId === contentId);
  }

  // ─── Queue Management ─────────────────────────────────────────────────────

  /**
   * Update moderation queue with new report.
   * Tracks priority based on report count and violation type.
   */
  private updateQueue(contentId: string, contentType: ContentType, reportedBy: string): void {
    const reports = this.getContentReports(contentId);
    let priority: "low" | "medium" | "high" | "critical" = "low";

    if (reports.length >= 10) {
      priority = "critical";
    } else if (reports.length >= 5) {
      priority = "high";
    } else if (reports.length >= 3) {
      priority = "medium";
    }

    // Check for high-severity violations
    if (reports.some((r) => ["malware", "copyright", "abuse"].includes(r.reason))) {
      priority = "critical";
    }

    const queueEntry: ModerationQueue = {
      reportId: reports[reports.length - 1].id,
      contentId,
      contentType,
      reportCount: reports.length,
      priority,
      createdAt: new Date().toISOString(),
    };

    // Remove duplicate if exists
    this.reportQueue = this.reportQueue.filter((q) => q.contentId !== contentId);
    this.reportQueue.push(queueEntry);
    this.reportQueue.sort(
      (a, b) =>
        ({ critical: 0, high: 1, medium: 2, low: 3 }[b.priority] as number) -
        ({ critical: 0, high: 1, medium: 2, low: 3 }[a.priority] as number),
    );
  }

  getQueue(limit = 20): ModerationQueue[] {
    return this.reportQueue.slice(0, limit);
  }

  getQueueStats(): {
    total: number;
    critical: number;
    high: number;
    medium: number;
    low: number;
  } {
    const stats = { total: this.reportQueue.length, critical: 0, high: 0, medium: 0, low: 0 };
    for (const q of this.reportQueue) {
      stats[q.priority]++;
    }
    return stats;
  }

  // ─── Automated Spam Detection ─────────────────────────────────────────────

  /**
   * Analyze content for spam signals.
   * Returns a score 0-100 indicating spam likelihood.
   */
  detectSpam(content: string, metadata: Record<string, unknown>): SpamSignals {
    const signals: SpamSignals = {
      hasMultipleReports: false,
      hasAbusiveLanguage: false,
      hasExcessiveLinks: false,
      hasSuspiciousPatterns: false,
      isNewAccount: false,
      score: 0,
    };

    // Abusive language detection (simple keyword-based)
    const abusiveWords = [
      "kill",
      "hate",
      "stupid",
      "idiot",
      "worthless",
      "deserve to die",
    ];
    if (abusiveWords.some((word) => content.toLowerCase().includes(word))) {
      signals.hasAbusiveLanguage = true;
      signals.score += 30;
    }

    // Excessive links (> 3 links per 100 chars)
    const linkCount = (content.match(/https?:\/\//g) || []).length;
    if (linkCount > Math.max(3, content.length / 100)) {
      signals.hasExcessiveLinks = true;
      signals.score += 25;
    }

    // Suspicious patterns: all caps, repeated chars, spam keywords
    const allCaps = (content.match(/[A-Z]/g) || []).length > content.length * 0.8;
    const repeatedChars = /(.)\1{4,}/.test(content);
    const spamKeywords = [
      "click here now",
      "buy now",
      "limited offer",
      "act now",
      "guaranteed",
    ];
    const hasSuspicious =
      allCaps || repeatedChars || spamKeywords.some((kw) => content.toLowerCase().includes(kw));

    if (hasSuspicious) {
      signals.hasSuspiciousPatterns = true;
      signals.score += 25;
    }

    // Check if author is new
    if (metadata.createdAt && typeof metadata.createdAt === "string") {
      const createdDate = new Date(metadata.createdAt);
      const ageMs = Date.now() - createdDate.getTime();
      const ageDays = ageMs / (1000 * 60 * 60 * 24);
      if (ageDays < 7) {
        signals.isNewAccount = true;
        signals.score += 20;
      }
    }

    return signals;
  }

  // ─── Moderation Actions ───────────────────────────────────────────────────

  /**
   * Take a moderation action: warning, suspend, or ban.
   */
  takeAction(
    reportId: string,
    contentId: string,
    action: "warning" | "suspend_comment" | "unpublish" | "suspend_user" | "ban_user",
    reason: string,
    duration?: number,
    appliedBy: string = "system",
  ): ModerationAction {
    const actionId = IdGenerators.modAction();

    const modAction: ModerationAction = {
      id: actionId,
      reportId,
      contentId,
      action,
      reason,
      duration,
      appliedBy,
      appliedAt: new Date().toISOString(),
      metadata: {},
    };

    this.actions.set(actionId, modAction);

    // Update report status
    const report = this.reports.get(reportId);
    if (report) {
      report.status = action === "warning" ? "approved" : "approved";
      report.updatedAt = new Date().toISOString();
    }

    // Handle user suspensions/bans
    const report2 = this.reports.get(reportId);
    if (report2) {
      if (action === "suspend_user" && duration) {
        const until = new Date(Date.now() + duration * 24 * 60 * 60 * 1000);
        this.suspendedUsers.set(report2.reportedBy, { until, reason });
      } else if (action === "ban_user") {
        this.bannedUsers.add(report2.reportedBy);
      }
    }

    return modAction;
  }

  getAction(actionId: string): ModerationAction | null {
    return this.actions.get(actionId) || null;
  }

  getContentActions(contentId: string): ModerationAction[] {
    return [...this.actions.values()].filter((a) => a.contentId === contentId);
  }

  isSuspended(userId: string): boolean {
    const suspension = this.suspendedUsers.get(userId);
    if (!suspension) return false;
    return new Date() < suspension.until;
  }

  isBanned(userId: string): boolean {
    return this.bannedUsers.has(userId);
  }

  getSuspensionStatus(userId: string): { until: Date; reason: string } | null {
    return this.suspendedUsers.get(userId) || null;
  }

  // ─── Appeals ──────────────────────────────────────────────────────────────

  /**
   * File an appeal against a moderation action.
   */
  fileAppeal(
    actionId: string,
    reportId: string,
    contentId: string,
    appealedBy: string,
    reason: string,
    evidence: string[] = [],
  ): Appeal {
    const appealId = IdGenerators.appeal();
    const appeal: Appeal = {
      id: appealId,
      actionId,
      reportId,
      contentId,
      appealedBy,
      reason,
      evidence,
      status: "pending",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.appeals.set(appealId, appeal);

    // Update report status
    const report = this.reports.get(reportId);
    if (report) {
      report.status = "appealed";
      report.updatedAt = new Date().toISOString();
    }

    return appeal;
  }

  getAppeal(appealId: string): Appeal | null {
    return this.appeals.get(appealId) || null;
  }

  getPendingAppeals(limit = 20): Appeal[] {
    return [...this.appeals.values()]
      .filter((a) => a.status === "pending")
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      .slice(0, limit);
  }

  /**
   * Review an appeal: uphold or overturn the original action.
   */
  reviewAppeal(
    appealId: string,
    reviewedBy: string,
    decision: "upheld" | "overturned",
    reason: string,
  ): Appeal | null {
    const appeal = this.appeals.get(appealId);
    if (!appeal || appeal.status !== "pending") return null;

    appeal.status = decision;
    appeal.reviewedBy = reviewedBy;
    appeal.reviewedAt = new Date().toISOString();
    appeal.decision = reason;
    appeal.updatedAt = new Date().toISOString();

    // If appeal overturned, remove suspension/ban
    if (decision === "overturned") {
      const action = this.actions.get(appeal.actionId);
      if (action) {
        const report = this.reports.get(appeal.reportId);
        if (report && report.reportedBy) {
          if (action.action === "suspend_user") {
            this.suspendedUsers.delete(report.reportedBy);
          } else if (action.action === "ban_user") {
            this.bannedUsers.delete(report.reportedBy);
          }
        }
      }
    }

    return appeal;
  }

  // ─── Community Guidelines ─────────────────────────────────────────────────

  registerGuideline(
    title: string,
    description: string,
    examples: string[],
    consequenceLevel: "warning" | "suspension" | "ban",
  ): CommunityGuideline {
    const id = `guideline-${Date.now()}`;
    const guideline: CommunityGuideline = {
      id,
      title,
      description,
      examples,
      consequenceLevel,
      active: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.guidelines.set(id, guideline);
    return guideline;
  }

  getGuideline(id: string): CommunityGuideline | null {
    return this.guidelines.get(id) || null;
  }

  getActiveGuidelines(): CommunityGuideline[] {
    return [...this.guidelines.values()].filter((g) => g.active);
  }

  deactivateGuideline(id: string): boolean {
    const guideline = this.guidelines.get(id);
    if (!guideline) return false;
    guideline.active = false;
    guideline.updatedAt = new Date().toISOString();
    return true;
  }

  // ─── Statistics ───────────────────────────────────────────────────────────

  getModerationStats(): ModerationStats {
    const reports = [...this.reports.values()];
    const actions = [...this.actions.values()];
    const appeals = [...this.appeals.values()];

    const approvedCount = reports.filter((r) => r.status === "approved").length;
    const rejectedCount = reports.filter((r) => r.status === "rejected").length;
    const pendingCount = reports.filter((r) => r.status === "pending").length;
    const appealsCount = appeals.length;
    const suspensionsCount = actions.filter((a) => a.action === "suspend_user").length;
    const bansCount = actions.filter((a) => a.action === "ban_user").length;

    // Calculate average resolution time
    const resolved = reports.filter((r) => r.status === "approved" || r.status === "rejected");
    const avgTime =
      resolved.length > 0
        ? resolved.reduce((sum, r) => {
            const createdMs = new Date(r.createdAt).getTime();
            const updatedMs = new Date(r.updatedAt).getTime();
            return sum + (updatedMs - createdMs);
          }, 0) / resolved.length
        : 0;

    return {
      totalReports: reports.length,
      approvedCount,
      rejectedCount,
      pendingCount,
      appealsCount,
      suspensionsCount,
      bansCount,
      averageResolutionTimeMs: Math.round(avgTime),
    };
  }

  // ─── Cache helpers ────────────────────────────────────────────────────────

  getReportsCache(): Map<string, ModerationReport> {
    return this.reports;
  }

  getActionsCache(): Map<string, ModerationAction> {
    return this.actions;
  }

  getAppealCache(): Map<string, Appeal> {
    return this.appeals;
  }
}
