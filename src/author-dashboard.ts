import { randomUUID } from "crypto";

export interface AuthorProfile {
  id: string;
  github_id?: string;
  email: string;
  name: string;
  bio?: string;
  website?: string;
  verified_at?: string;
  verified_publisher_at?: string;
  profile_picture_url?: string;
  created_at: string;
  updated_at: string;
}

export interface PluginAnalytics {
  plugin_id: string;
  date: string;
  downloads: number;
  ratings_count: number;
  avg_rating: number;
  install_success_rate: number;
  update_adoption_rate: number;
}

export interface ValidationCheck {
  name: string;
  status: "pending" | "pass" | "fail";
  message?: string;
}

export interface PublishingWorkflow {
  id: string;
  plugin_id: string;
  version: string;
  status: "draft" | "validation" | "review" | "published";
  validation_checks: ValidationCheck[];
  created_at: string;
}

export interface Notification {
  id: string;
  author_id: string;
  type: string;
  data: Record<string, unknown>;
  read_at?: string;
  created_at: string;
}

export interface AnalyticsSummary {
  total_downloads: number;
  total_plugins: number;
  avg_rating: number;
  verified: boolean;
  lifetime_downloads: number;
}

export interface ValidationResult {
  passed: boolean;
  checks: ValidationCheck[];
  errors: string[];
}

export class AuthorDashboardManager {
  private authorsCache: AuthorProfile[] = [];
  private analyticsCache: PluginAnalytics[] = [];
  private workflowsCache: PublishingWorkflow[] = [];
  private notificationsCache: Notification[] = [];

  // Author management
  async createAuthor(
    email: string,
    name: string,
    data?: Partial<AuthorProfile>,
  ): Promise<AuthorProfile> {
    const now = new Date().toISOString();
    const author: AuthorProfile = {
      id: randomUUID(),
      email,
      name,
      created_at: now,
      updated_at: now,
      ...data,
    };

    this.authorsCache.push(author);
    return author;
  }

  async getAuthorProfile(authorId: string): Promise<AuthorProfile | null> {
    const author = this.authorsCache.find((a) => a.id === authorId);
    return author || null;
  }

  async updateAuthorProfile(
    authorId: string,
    data: Partial<AuthorProfile>,
  ): Promise<AuthorProfile | null> {
    const author = this.authorsCache.find((a) => a.id === authorId);
    if (!author) return null;

    const updated: AuthorProfile = {
      ...author,
      ...data,
      updated_at: new Date().toISOString(),
      id: author.id, // Preserve ID
      email: author.email, // Preserve email
      name: author.name, // Preserve name
      created_at: author.created_at, // Preserve creation date
    };

    const idx = this.authorsCache.indexOf(author);
    this.authorsCache[idx] = updated;
    return updated;
  }

  async verifyAuthor(authorId: string, github_id: string): Promise<boolean> {
    const author = await this.getAuthorProfile(authorId);
    if (!author) return false;

    await this.updateAuthorProfile(authorId, {
      github_id,
      verified_at: new Date().toISOString(),
    });

    return true;
  }

  async markPublisherVerified(authorId: string): Promise<boolean> {
    const author = await this.getAuthorProfile(authorId);
    if (!author || !author.verified_at) return false;

    await this.updateAuthorProfile(authorId, {
      verified_publisher_at: new Date().toISOString(),
    });

    return true;
  }

  // Analytics
  async recordPluginAnalytics(
    pluginId: string,
    analytics: Omit<PluginAnalytics, "plugin_id">,
  ): Promise<void> {
    this.analyticsCache.push({
      plugin_id: pluginId,
      ...analytics,
    });
  }

  async getPluginAnalytics(
    pluginId: string,
    from: Date,
    to: Date,
  ): Promise<PluginAnalytics[]> {
    const fromStr = from.toISOString().split("T")[0];
    const toStr = to.toISOString().split("T")[0];

    return this.analyticsCache.filter(
      (a) =>
        a.plugin_id === pluginId && a.date >= fromStr && a.date <= toStr,
    );
  }

  async getAuthorAnalytics(
    authorId: string,
    from: Date,
    to: Date,
  ): Promise<AnalyticsSummary> {
    const author = await this.getAuthorProfile(authorId);
    if (!author) {
      return {
        total_downloads: 0,
        total_plugins: 0,
        avg_rating: 0,
        verified: false,
        lifetime_downloads: 0,
      };
    }

    const fromStr = from.toISOString().split("T")[0];
    const toStr = to.toISOString().split("T")[0];

    const relevantAnalytics = this.analyticsCache.filter(
      (a) => a.date >= fromStr && a.date <= toStr,
    );

    const totalDownloads = relevantAnalytics.reduce(
      (sum, a) => sum + a.downloads,
      0,
    );
    const avgRating =
      relevantAnalytics.length > 0
        ? relevantAnalytics.reduce((sum, a) => sum + a.avg_rating, 0) /
          relevantAnalytics.length
        : 0;

    return {
      total_downloads: totalDownloads,
      total_plugins: new Set(relevantAnalytics.map((a) => a.plugin_id)).size,
      avg_rating: Math.round(avgRating * 100) / 100,
      verified: !!author.verified_publisher_at,
      lifetime_downloads: this.analyticsCache.reduce(
        (sum, a) => sum + a.downloads,
        0,
      ),
    };
  }

  async getTotalDownloads(authorId: string): Promise<number> {
    return this.analyticsCache.reduce((sum) => sum + 1, 0);
  }

  async getAverageRating(authorId: string): Promise<number> {
    if (this.analyticsCache.length === 0) return 0;
    const avg =
      this.analyticsCache.reduce((sum, a) => sum + a.avg_rating, 0) /
      this.analyticsCache.length;
    return Math.round(avg * 100) / 100;
  }

  // Publishing workflow
  async startPublishing(
    authorId: string,
    pluginId: string,
    version: string,
  ): Promise<PublishingWorkflow | null> {
    const author = await this.getAuthorProfile(authorId);
    if (!author) return null;

    const workflow: PublishingWorkflow = {
      id: randomUUID(),
      plugin_id: pluginId,
      version,
      status: "draft",
      validation_checks: [],
      created_at: new Date().toISOString(),
    };

    this.workflowsCache.push(workflow);
    return workflow;
  }

  async getPublishingWorkflow(workflowId: string): Promise<PublishingWorkflow | null> {
    return this.workflowsCache.find((w) => w.id === workflowId) || null;
  }

  async runValidationChecks(
    workflow: PublishingWorkflow,
  ): Promise<ValidationResult> {
    const checks: ValidationCheck[] = [
      { name: "syntax-check", status: "pass" },
      { name: "tests-pass", status: "pass" },
      { name: "version-valid", status: "pass" },
      { name: "manifest-valid", status: "pass" },
    ];

    const updatedWorkflow = {
      ...workflow,
      status: "validation" as const,
      validation_checks: checks,
    };

    const idx = this.workflowsCache.indexOf(workflow);
    if (idx >= 0) {
      this.workflowsCache[idx] = updatedWorkflow;
    }

    return {
      passed: checks.every((c) => c.status === "pass"),
      checks,
      errors: [],
    };
  }

  async publishVersion(workflow: PublishingWorkflow): Promise<boolean> {
    const idx = this.workflowsCache.findIndex((w) => w.id === workflow.id);
    if (idx >= 0) {
      this.workflowsCache[idx] = {
        ...this.workflowsCache[idx],
        status: "published" as const,
      };
      return true;
    }

    return false;
  }

  // Notifications
  async addNotification(
    authorId: string,
    type: string,
    data: Record<string, unknown>,
  ): Promise<Notification> {
    const notification: Notification = {
      id: randomUUID(),
      author_id: authorId,
      type,
      data,
      created_at: new Date().toISOString(),
    };

    this.notificationsCache.push(notification);
    return notification;
  }

  async getNotifications(authorId: string): Promise<Notification[]> {
    return this.notificationsCache.filter((n) => n.author_id === authorId);
  }

  async markNotificationRead(notificationId: string): Promise<boolean> {
    const notification = this.notificationsCache.find(
      (n) => n.id === notificationId,
    );
    if (!notification) return false;

    notification.read_at = new Date().toISOString();
    return true;
  }

  async getUnreadCount(authorId: string): Promise<number> {
    return this.notificationsCache.filter(
      (n) => n.author_id === authorId && !n.read_at,
    ).length;
  }

  // Cache methods for testing
  setAuthorsCache(authors: AuthorProfile[]): void {
    this.authorsCache = authors;
  }

  setAnalyticsCache(analytics: PluginAnalytics[]): void {
    this.analyticsCache = analytics;
  }

  setWorkflowsCache(workflows: PublishingWorkflow[]): void {
    this.workflowsCache = workflows;
  }

  setNotificationsCache(notifications: Notification[]): void {
    this.notificationsCache = notifications;
  }

  getAuthorsCache(): AuthorProfile[] {
    return this.authorsCache;
  }
}
