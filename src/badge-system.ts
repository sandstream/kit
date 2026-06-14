// ─── Types ────────────────────────────────────────────────────────────────────

export type BadgeType =
  | "official"
  | "top_rated"
  | "trending"
  | "secure"
  | "well_documented"
  | "verified"
  | "popular"
  | "actively_maintained";

export interface BadgeCriteria {
  type: BadgeType;
  label: string;
  icon: string;
  description: string;
  criteria: Record<string, number | boolean | string>;
}

export interface Badge {
  type: BadgeType;
  label: string;
  icon: string;
  description: string;
  earnedAt: string;
  expiresAt?: string;
}

export interface PluginMetrics {
  pluginId: string;
  authorId: string;
  rating: number;
  reviewsCount: number;
  downloadsMonth: number;
  downloadsWeek: number;
  downloadsTotal: number;
  trendingScore: number;
  isOfficial: boolean;
  hasSecurityAudit: boolean;
  docsUrl?: string;
  docsPageCount?: number;
  lastUpdateDays: number;
  authorVerified: boolean;
  maintainedByOrg?: boolean;
}

export interface BadgeAuditEntry {
  pluginId: string;
  badgeType: BadgeType;
  action: "awarded" | "revoked" | "renewed";
  reason: string;
  timestamp: string;
}

export interface BadgeReport {
  pluginId: string;
  badges: Badge[];
  evaluated: BadgeCriteria[];
  passed: BadgeType[];
  failed: BadgeType[];
  auditLog: BadgeAuditEntry[];
}

// ─── Criteria definitions ────────────────────────────────────────────────────

export const BADGE_DEFINITIONS: Record<BadgeType, BadgeCriteria> = {
  official: {
    type: "official",
    label: "Official",
    icon: "⭐",
    description: "Maintained and officially supported by Sandstream",
    criteria: { isOfficial: true },
  },
  top_rated: {
    type: "top_rated",
    label: "Top Rated",
    icon: "🏆",
    description: "Average rating of 4.8 or higher with 50+ reviews",
    criteria: { minRating: 4.8, minReviews: 50 },
  },
  trending: {
    type: "trending",
    label: "Trending",
    icon: "🚀",
    description: "Rapidly growing downloads over the past week",
    criteria: { minTrendingScore: 700, minWeeklyDownloads: 100 },
  },
  secure: {
    type: "secure",
    label: "Security Audited",
    icon: "🔒",
    description: "Has passed a security audit",
    criteria: { hasSecurityAudit: true },
  },
  well_documented: {
    type: "well_documented",
    label: "Well Documented",
    icon: "📚",
    description: "Has comprehensive documentation with 5+ pages",
    criteria: { hasDocsUrl: true, minDocPages: 5 },
  },
  verified: {
    type: "verified",
    label: "Verified Publisher",
    icon: "✅",
    description: "Published by a verified and trusted author",
    criteria: { authorVerified: true },
  },
  popular: {
    type: "popular",
    label: "Popular",
    icon: "🔥",
    description: "Over 1,000 monthly downloads",
    criteria: { minMonthlyDownloads: 1000 },
  },
  actively_maintained: {
    type: "actively_maintained",
    label: "Actively Maintained",
    icon: "🔧",
    description: "Updated within the last 90 days",
    criteria: { maxLastUpdateDays: 90 },
  },
};

// ─── BadgeSystem ─────────────────────────────────────────────────────────────

export class BadgeSystem {
  private pluginBadges: Map<string, Badge[]> = new Map();
  private auditLog: BadgeAuditEntry[] = [];

  // ─── Criteria evaluation ───────────────────────────────────────────────────

  evaluateBadge(type: BadgeType, metrics: PluginMetrics): boolean {
    switch (type) {
      case "official":
        return metrics.isOfficial;

      case "top_rated":
        return metrics.rating >= 4.8 && metrics.reviewsCount >= 50;

      case "trending":
        return (
          metrics.trendingScore >= 700 && metrics.downloadsWeek >= 100
        );

      case "secure":
        return metrics.hasSecurityAudit;

      case "well_documented":
        return !!(metrics.docsUrl && (metrics.docsPageCount || 0) >= 5);

      case "verified":
        return metrics.authorVerified;

      case "popular":
        return metrics.downloadsMonth >= 1000;

      case "actively_maintained":
        return metrics.lastUpdateDays <= 90;

      default:
        return false;
    }
  }

  evaluateAllBadges(metrics: PluginMetrics): BadgeType[] {
    const earned: BadgeType[] = [];
    for (const type of Object.keys(BADGE_DEFINITIONS) as BadgeType[]) {
      if (this.evaluateBadge(type, metrics)) {
        earned.push(type);
      }
    }
    return earned;
  }

  // ─── Badge management ──────────────────────────────────────────────────────

  awardBadge(pluginId: string, type: BadgeType, reason = "criteria met"): Badge {
    const definition = BADGE_DEFINITIONS[type];
    const badge: Badge = {
      type,
      label: definition.label,
      icon: definition.icon,
      description: definition.description,
      earnedAt: new Date().toISOString(),
    };

    const existing = this.pluginBadges.get(pluginId) || [];
    const alreadyHas = existing.some((b) => b.type === type);
    if (!alreadyHas) {
      this.pluginBadges.set(pluginId, [...existing, badge]);
    }

    this.auditLog.push({
      pluginId,
      badgeType: type,
      action: alreadyHas ? "renewed" : "awarded",
      reason,
      timestamp: new Date().toISOString(),
    });

    return badge;
  }

  revokeBadge(pluginId: string, type: BadgeType, reason: string): boolean {
    const badges = this.pluginBadges.get(pluginId);
    if (!badges) return false;

    const filtered = badges.filter((b) => b.type !== type);
    if (filtered.length === badges.length) return false;

    this.pluginBadges.set(pluginId, filtered);

    this.auditLog.push({
      pluginId,
      badgeType: type,
      action: "revoked",
      reason,
      timestamp: new Date().toISOString(),
    });

    return true;
  }

  // ─── Sync (award/revoke based on current metrics) ─────────────────────────

  syncBadges(pluginId: string, metrics: PluginMetrics): BadgeReport {
    const earned = this.evaluateAllBadges(metrics);
    const current = this.getPluginBadges(pluginId).map((b) => b.type);

    const toAward = earned.filter((t) => !current.includes(t));
    const toRevoke = current.filter((t) => !earned.includes(t));

    for (const type of toAward) {
      this.awardBadge(pluginId, type, "automatic sync — criteria met");
    }
    for (const type of toRevoke) {
      this.revokeBadge(
        pluginId,
        type,
        "automatic sync — criteria no longer met",
      );
    }

    const allTypes = Object.keys(BADGE_DEFINITIONS) as BadgeType[];

    return {
      pluginId,
      badges: this.getPluginBadges(pluginId),
      evaluated: allTypes.map((t) => BADGE_DEFINITIONS[t]),
      passed: earned,
      failed: allTypes.filter((t) => !earned.includes(t)),
      auditLog: this.auditLog.filter((e) => e.pluginId === pluginId),
    };
  }

  // ─── Queries ──────────────────────────────────────────────────────────────

  getPluginBadges(pluginId: string): Badge[] {
    return this.pluginBadges.get(pluginId) || [];
  }

  hasBadge(pluginId: string, type: BadgeType): boolean {
    return this.getPluginBadges(pluginId).some((b) => b.type === type);
  }

  getPluginsByBadge(type: BadgeType): string[] {
    const result: string[] = [];
    for (const [pluginId, badges] of this.pluginBadges) {
      if (badges.some((b) => b.type === type)) {
        result.push(pluginId);
      }
    }
    return result;
  }

  getBadgeStats(): Record<BadgeType, number> {
    const stats = {} as Record<BadgeType, number>;
    for (const type of Object.keys(BADGE_DEFINITIONS) as BadgeType[]) {
      stats[type] = this.getPluginsByBadge(type).length;
    }
    return stats;
  }

  getAuditLog(pluginId?: string): BadgeAuditEntry[] {
    if (pluginId) {
      return this.auditLog.filter((e) => e.pluginId === pluginId);
    }
    return this.auditLog;
  }

  getBadgeDefinitions(): Record<BadgeType, BadgeCriteria> {
    return BADGE_DEFINITIONS;
  }

  // ─── Display helpers ─────────────────────────────────────────────────────

  formatBadgesForDisplay(pluginId: string): string {
    const badges = this.getPluginBadges(pluginId);
    if (badges.length === 0) return "";
    return badges.map((b) => `${b.icon} ${b.label}`).join("  ");
  }

  // ─── Cache helpers ────────────────────────────────────────────────────────

  clearBadges(pluginId: string): void {
    this.pluginBadges.delete(pluginId);
  }

  setBadgesCache(entries: Array<{ pluginId: string; badges: Badge[] }>): void {
    this.pluginBadges.clear();
    for (const { pluginId, badges } of entries) {
      this.pluginBadges.set(pluginId, badges);
    }
  }
}
