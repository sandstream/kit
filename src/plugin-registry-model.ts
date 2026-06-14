/**
 * Plugin Registry — data models
 * Plugin certification, versioning, audit trails, and registry management
 */

export type CertificationTier = "bronze" | "silver" | "gold" | "platinum";
export type PluginStatus = "draft" | "submitted" | "certified" | "deprecated" | "blacklisted";
export type CertificationStatus =
  | "pending"
  | "reviewing"
  | "approved"
  | "rejected"
  | "revoked"
  | "expired";
export type VersionStatus = "draft" | "released" | "deprecated" | "yanked";

export interface PluginVersion {
  id: string;
  plugin_id: string;
  version: string; // semver
  status: VersionStatus;
  release_date: string;
  deprecated_date?: string;
  yank_reason?: string;
  file_hash: string;
  file_size: number;
  changelog?: string;
  breaking_changes: string[];
  dependencies: { name: string; version_range: string }[];
  created_at: string;
  updated_at: string;
}

export interface Plugin {
  id: string;
  name: string;
  slug: string; // URL-safe identifier
  description: string;
  long_description?: string;
  author_id: string;
  author_name: string;
  category: string;
  tags: string[];
  homepage?: string;
  documentation?: string;
  repository?: string;
  license: string;
  status: PluginStatus;
  current_version: string;
  versions: PluginVersion[];
  certification_tier: CertificationTier;
  certification_status: CertificationStatus;
  certification_date?: string;
  certified_by?: string;
  downloads: number;
  rating: number;
  rating_count: number;
  verified_author: boolean;
  maintainer_contact?: string;
  created_at: string;
  updated_at: string;
}

export interface CertificationAudit {
  id: string;
  plugin_id: string;
  plugin_version: string;
  certification_tier: CertificationTier;
  status: CertificationStatus;
  reviewer_id: string;
  reviewer_name: string;
  security_score: number; // 0-100
  performance_score: number; // 0-100
  code_quality_score: number; // 0-100
  test_coverage_percent: number;
  findings: {
    category: string;
    severity: "info" | "warning" | "critical";
    description: string;
    resolved: boolean;
  }[];
  approval_notes?: string;
  rejection_reason?: string;
  certification_date: string;
  expires_at?: string;
  created_at: string;
  updated_at: string;
}

export interface PluginRollback {
  id: string;
  plugin_id: string;
  from_version: string;
  to_version: string;
  reason: string;
  triggered_by: string;
  triggered_at: string;
  security_issue?: string;
  created_at: string;
}

export interface RegistryAuditLog {
  id: string;
  plugin_id: string;
  action: string; // "submitted", "certified", "rejected", "deprecated", "yanked", "reinstated"
  actor_id: string;
  actor_name: string;
  actor_role: "developer" | "reviewer" | "admin";
  details: Record<string, unknown>;
  timestamp: string;
  created_at: string;
}

export interface PluginDependency {
  id: string;
  plugin_id: string;
  depends_on_plugin_id: string;
  depends_on_name: string;
  version_constraint: string;
  is_optional: boolean;
  created_at: string;
}

export interface RegistryMetrics {
  total_plugins: number;
  certified_plugins: number;
  total_versions: number;
  total_downloads: number;
  average_rating: number;
  plugins_by_tier: Record<CertificationTier, number>;
  plugins_by_status: Record<PluginStatus, number>;
  security_issues_count: number;
  rollbacks_last_30_days: number;
  average_time_to_certification_hours: number;
}

export interface PluginSearchQuery {
  query?: string;
  category?: string;
  certification_tier?: CertificationTier;
  status?: PluginStatus;
  sort_by: "rating" | "downloads" | "recent" | "trending";
  limit: number;
  offset: number;
}
