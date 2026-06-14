import { IdGenerators } from "./id-generator.js";
// ─── Types ────────────────────────────────────────────────────────────────────

export type NotificationType =
  | "new_review"
  | "new_rating"
  | "download_milestone"
  | "update_reminder"
  | "security_alert"
  | "dependency_update"
  | "plugin_published"
  | "rating_threshold"
  | "community_digest"
  | "comment_reply";

export type NotificationChannel = "in_app" | "email" | "digest";
export type DigestFrequency = "daily" | "weekly" | "monthly" | "off";

export interface Notification {
  id: string;
  authorId: string;
  type: NotificationType;
  pluginId?: string;
  title: string;
  message: string;
  metadata: Record<string, unknown>;
  read: boolean;
  channels: NotificationChannel[];
  createdAt: string;
  readAt?: string;
}

export interface NotificationPreference {
  authorId: string;
  notificationType: NotificationType;
  channels: NotificationChannel[];
  enabled: boolean;
  updatedAt: string;
}

export interface DigestSettings {
  authorId: string;
  frequency: DigestFrequency;
  preferredDay?: number; // 0=Sun, 6=Sat for weekly; day of month for monthly
  preferredTime?: string; // HH:MM format
  includeTypes: NotificationType[];
  updatedAt: string;
}

export interface DigestEntry {
  id: string;
  title: string;
  message: string;
  type: NotificationType;
  createdAt: string;
}

export interface CompiledDigest {
  authorId: string;
  frequency: DigestFrequency;
  period: string; // "2025-04-14 to 2025-04-20"
  entries: DigestEntry[];
  totalCount: number;
  unreadCount: number;
  compiledAt: string;
}

export interface NotificationStats {
  totalNotifications: number;
  unreadCount: number;
  byType: Record<NotificationType, number>;
  byStatus: { read: number; unread: number };
}

export interface DownloadMilestoneEvent {
  pluginId: string;
  authorId: string;
  milestone: number; // 100, 500, 1000, etc.
  currentDownloads: number;
  achievedAt: string;
}

// ─── AuthorNotificationEngine ─────────────────────────────────────────────────

export class AuthorNotificationEngine {
  private notifications: Map<string, Notification> = new Map();
  private preferences: Map<string, NotificationPreference> = new Map();
  private digestSettings: Map<string, DigestSettings> = new Map();
  private digestQueue: Map<string, DigestEntry[]> = new Map(); // authorId → entries
  private lastDigestSent: Map<string, string> = new Map(); // authorId → ISO date

  // ─── Notification creation & management ────────────────────────────────────

  /**
   * Create and send a notification to an author.
   */
  createNotification(
    authorId: string,
    type: NotificationType,
    title: string,
    message: string,
    metadata: Record<string, unknown> = {},
    pluginId?: string,
  ): Notification {
    const id = IdGenerators.notification();

    // Get author's notification preference for this type
    const prefKey = `${authorId}:${type}`;
    const pref = this.preferences.get(prefKey) || this.getDefaultPreference(authorId, type);

    const notification: Notification = {
      id,
      authorId,
      type,
      pluginId,
      title,
      message,
      metadata,
      read: false,
      channels: pref.channels,
      createdAt: new Date().toISOString(),
    };

    this.notifications.set(id, notification);

    // Add to digest queue if digest is enabled
    const digestSettings = this.digestSettings.get(authorId);
    if (digestSettings && digestSettings.includeTypes.includes(type)) {
      const queue = this.digestQueue.get(authorId) || [];
      queue.push({
        id: notification.id,
        title,
        message,
        type,
        createdAt: notification.createdAt,
      });
      this.digestQueue.set(authorId, queue);
    }

    return notification;
  }

  private getDefaultPreference(authorId: string, type: NotificationType): NotificationPreference {
    // Default preferences: send critical alerts to in_app, others to digest
    const criticalTypes: NotificationType[] = ["security_alert", "rating_threshold"];
    const channels: NotificationChannel[] = criticalTypes.includes(type)
      ? ["in_app", "email"]
      : ["in_app", "digest"];

    return {
      authorId,
      notificationType: type,
      channels,
      enabled: true,
      updatedAt: new Date().toISOString(),
    };
  }

  getNotification(notificationId: string): Notification | null {
    return this.notifications.get(notificationId) || null;
  }

  getAuthorNotifications(authorId: string, unreadOnly = false, limit = 50): Notification[] {
    return [...this.notifications.values()]
      .filter((n) => n.authorId === authorId && (!unreadOnly || !n.read))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, limit);
  }

  markAsRead(notificationId: string): Notification | null {
    const notif = this.notifications.get(notificationId);
    if (!notif) return null;
    notif.read = true;
    notif.readAt = new Date().toISOString();
    return notif;
  }

  markMultipleAsRead(authorId: string): number {
    const authorsNotifs = this.getAuthorNotifications(authorId, true);
    let count = 0;
    for (const notif of authorsNotifs) {
      notif.read = true;
      notif.readAt = new Date().toISOString();
      count++;
    }
    return count;
  }

  deleteNotification(notificationId: string): boolean {
    return this.notifications.delete(notificationId);
  }

  // ─── Notification preferences ─────────────────────────────────────────────

  /**
   * Set notification preferences for an author and notification type.
   */
  setPreference(
    authorId: string,
    type: NotificationType,
    channels: NotificationChannel[],
    enabled: boolean,
  ): NotificationPreference {
    const key = `${authorId}:${type}`;
    const pref: NotificationPreference = {
      authorId,
      notificationType: type,
      channels: enabled ? channels : [],
      enabled,
      updatedAt: new Date().toISOString(),
    };
    this.preferences.set(key, pref);
    return pref;
  }

  getPreference(authorId: string, type: NotificationType): NotificationPreference | null {
    const key = `${authorId}:${type}`;
    return this.preferences.get(key) || null;
  }

  getAuthorPreferences(authorId: string): NotificationPreference[] {
    return [...this.preferences.values()].filter((p) => p.authorId === authorId);
  }

  disableNotificationType(authorId: string, type: NotificationType): NotificationPreference {
    return this.setPreference(authorId, type, [], false);
  }

  enableNotificationType(
    authorId: string,
    type: NotificationType,
    channels: NotificationChannel[] = ["in_app", "email"],
  ): NotificationPreference {
    return this.setPreference(authorId, type, channels, true);
  }

  // ─── Digest management ─────────────────────────────────────────────────────

  /**
   * Configure digest settings for an author.
   */
  setDigestSettings(
    authorId: string,
    frequency: DigestFrequency,
    types: NotificationType[],
    preferredDay?: number,
    preferredTime?: string,
  ): DigestSettings {
    const settings: DigestSettings = {
      authorId,
      frequency,
      preferredDay,
      preferredTime: preferredTime || "09:00",
      includeTypes: types,
      updatedAt: new Date().toISOString(),
    };
    this.digestSettings.set(authorId, settings);
    return settings;
  }

  getDigestSettings(authorId: string): DigestSettings | null {
    return this.digestSettings.get(authorId) || null;
  }

  /**
   * Compile a digest from queued entries.
   */
  compileDigest(authorId: string, frequency: DigestFrequency): CompiledDigest | null {
    const settings = this.digestSettings.get(authorId);
    if (!settings || settings.frequency !== frequency) return null;

    const entries = this.digestQueue.get(authorId) || [];
    if (entries.length === 0) return null;

    const unreadNotifs = this.getAuthorNotifications(authorId, true);
    const unreadCount = unreadNotifs.length;

    // Determine period based on frequency
    const now = new Date();
    let period = "";
    if (frequency === "daily") {
      period = now.toISOString().split("T")[0];
    } else if (frequency === "weekly") {
      const weekStart = new Date(now);
      weekStart.setDate(now.getDate() - now.getDay());
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekStart.getDate() + 6);
      period = `${weekStart.toISOString().split("T")[0]} to ${weekEnd.toISOString().split("T")[0]}`;
    } else if (frequency === "monthly") {
      period = now.toISOString().slice(0, 7);
    }

    const digest: CompiledDigest = {
      authorId,
      frequency,
      period,
      entries: entries.slice(0, 100), // limit to 100 entries per digest
      totalCount: entries.length,
      unreadCount,
      compiledAt: new Date().toISOString(),
    };

    this.lastDigestSent.set(authorId, new Date().toISOString());
    // Clear queue after compiling
    this.digestQueue.set(authorId, []);

    return digest;
  }

  getLastDigestTime(authorId: string): Date | null {
    const time = this.lastDigestSent.get(authorId);
    return time ? new Date(time) : null;
  }

  getPendingDigestEntries(authorId: string): DigestEntry[] {
    return this.digestQueue.get(authorId) || [];
  }

  // ─── Event-based notifications ─────────────────────────────────────────────

  /**
   * Send notification when a plugin receives a new review.
   */
  notifyNewReview(
    authorId: string,
    pluginId: string,
    reviewerId: string,
    rating: number,
    comment: string,
  ): Notification {
    return this.createNotification(
      authorId,
      "new_review",
      `New review for your plugin`,
      `${reviewerId} left a ${rating}★ review: "${comment.slice(0, 100)}..."`,
      { reviewerId, rating, comment },
      pluginId,
    );
  }

  /**
   * Send notification on download milestones (100, 500, 1000, etc.).
   */
  notifyDownloadMilestone(
    authorId: string,
    pluginId: string,
    currentDownloads: number,
  ): Notification | null {
    const milestones = [100, 500, 1000, 5000, 10000, 50000, 100000];
    const milestone = milestones.find((m) => m === currentDownloads);

    if (!milestone) return null;

    return this.createNotification(
      authorId,
      "download_milestone",
      `🎉 Milestone reached!`,
      `Your plugin has reached ${milestone} downloads!`,
      { milestone, currentDownloads },
      pluginId,
    );
  }

  /**
   * Send security alert for vulnerabilities.
   */
  notifySecurityAlert(
    authorId: string,
    pluginId: string,
    vulnerability: string,
    severity: "low" | "medium" | "high" | "critical",
  ): Notification {
    return this.createNotification(
      authorId,
      "security_alert",
      `⚠️ Security alert`,
      `${severity.toUpperCase()}: ${vulnerability}. Please review and update.`,
      { vulnerability, severity },
      pluginId,
    );
  }

  /**
   * Send notification when rating drops below threshold.
   */
  notifyRatingThreshold(
    authorId: string,
    pluginId: string,
    currentRating: number,
    threshold: number,
  ): Notification | null {
    if (currentRating >= threshold) return null;

    return this.createNotification(
      authorId,
      "rating_threshold",
      `Rating alert`,
      `Your plugin's rating dropped to ${currentRating.toFixed(1)}★ (threshold: ${threshold}★)`,
      { currentRating, threshold },
      pluginId,
    );
  }

  /**
   * Send notification for dependency updates available.
   */
  notifyDependencyUpdate(
    authorId: string,
    pluginId: string,
    dependency: string,
    newVersion: string,
  ): Notification {
    return this.createNotification(
      authorId,
      "dependency_update",
      `Dependency update available`,
      `${dependency} has a new version: ${newVersion}. Consider updating.`,
      { dependency, newVersion },
      pluginId,
    );
  }

  /**
   * Send digest compilation notification.
   */
  notifyCommunityDigest(authorId: string, digest: CompiledDigest): Notification {
    return this.createNotification(
      authorId,
      "community_digest",
      `${digest.frequency} digest`,
      `You have ${digest.totalCount} new updates from the community`,
      digest as unknown as Record<string, unknown>,
    );
  }

  // ─── Statistics ────────────────────────────────────────────────────────────

  /**
   * Get notification statistics for an author.
   */
  getNotificationStats(authorId: string): NotificationStats {
    const authorNotifs = this.getAuthorNotifications(authorId);

    const byType: Record<NotificationType, number> = {} as Record<NotificationType, number>;
    for (const notif of authorNotifs) {
      byType[notif.type] = (byType[notif.type] || 0) + 1;
    }

    return {
      totalNotifications: authorNotifs.length,
      unreadCount: authorNotifs.filter((n) => !n.read).length,
      byType,
      byStatus: {
        read: authorNotifs.filter((n) => n.read).length,
        unread: authorNotifs.filter((n) => !n.read).length,
      },
    };
  }

  // ─── Cache helpers ────────────────────────────────────────────────────────

  getNotificationsCache(): Map<string, Notification> {
    return this.notifications;
  }

  getPreferencesCache(): Map<string, NotificationPreference> {
    return this.preferences;
  }

  getDigestSettingsCache(): Map<string, DigestSettings> {
    return this.digestSettings;
  }
}
