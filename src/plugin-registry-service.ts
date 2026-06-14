import { randomUUID } from "node:crypto";
import type {
  Plugin,
  PluginVersion,
  CertificationAudit,
  PluginRollback,
  RegistryAuditLog,
  PluginDependency,
  RegistryMetrics,
  PluginSearchQuery,
  CertificationTier,
} from "./plugin-registry-model.js";

const plugins = new Map<string, Plugin>();
const certifications = new Map<string, CertificationAudit>();
const rollbacks = new Map<string, PluginRollback>();
const auditLogs = new Map<string, RegistryAuditLog>();
const dependencies = new Map<string, PluginDependency>();

/**
 * Submit plugin to registry
 */
export function submitPlugin(
  plugin_name: string,
  author_id: string,
  author_name: string,
  description: string,
  category: string,
): { plugin: Plugin; error?: string } {
  const slug = plugin_name.toLowerCase().replace(/\s+/g, "-");

  const plugin: Plugin = {
    id: `plugin_${randomUUID()}`,
    name: plugin_name,
    slug,
    description,
    author_id,
    author_name,
    category,
    tags: [],
    license: "MIT",
    status: "submitted",
    current_version: "1.0.0",
    versions: [],
    certification_tier: "bronze",
    certification_status: "pending",
    downloads: 0,
    rating: 0,
    rating_count: 0,
    verified_author: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  plugins.set(plugin.id, plugin);
  logAudit(plugin.id, "submitted", author_id, author_name, "developer");

  return { plugin };
}

/**
 * Add version to plugin
 */
export function addPluginVersion(
  plugin_id: string,
  version: string,
  file_hash: string,
  file_size: number,
  changelog?: string,
): { pluginVersion: PluginVersion; error?: string } {
  const plugin = plugins.get(plugin_id);
  if (!plugin) {
    return { pluginVersion: {} as PluginVersion, error: "Plugin not found" };
  }

  const pluginVersion: PluginVersion = {
    id: `version_${randomUUID()}`,
    plugin_id,
    version,
    status: "draft",
    release_date: new Date().toISOString(),
    file_hash,
    file_size,
    changelog,
    breaking_changes: [],
    dependencies: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  plugin.versions.push(pluginVersion);
  if (!plugin.current_version || version > plugin.current_version) {
    plugin.current_version = version;
  }
  plugin.updated_at = new Date().toISOString();

  return { pluginVersion };
}

/**
 * Release plugin version
 */
export function releasePluginVersion(
  plugin_id: string,
  version: string,
): { pluginVersion: PluginVersion | null; error?: string } {
  const plugin = plugins.get(plugin_id);
  if (!plugin) {
    return { pluginVersion: null, error: "Plugin not found" };
  }

  const pluginVersion = plugin.versions.find((v) => v.version === version);
  if (!pluginVersion) {
    return { pluginVersion: null, error: "Version not found" };
  }

  pluginVersion.status = "released";
  plugin.updated_at = new Date().toISOString();

  return { pluginVersion };
}

/**
 * Submit for certification
 */
export function submitForCertification(
  plugin_id: string,
  version: string,
  tier: CertificationTier,
): { plugin: Plugin; error?: string } {
  const plugin = plugins.get(plugin_id);
  if (!plugin) {
    return { plugin: {} as Plugin, error: "Plugin not found" };
  }

  plugin.certification_tier = tier;
  plugin.certification_status = "reviewing";
  plugin.status = "submitted";
  plugin.updated_at = new Date().toISOString();

  return { plugin };
}

/**
 * Certify plugin
 */
export function certifyPlugin(
  plugin_id: string,
  version: string,
  tier: CertificationTier,
  reviewer_id: string,
  reviewer_name: string,
  security_score: number,
  performance_score: number,
  code_quality_score: number,
  test_coverage: number,
): { audit: CertificationAudit; error?: string } {
  const plugin = plugins.get(plugin_id);
  if (!plugin) {
    return { audit: {} as CertificationAudit, error: "Plugin not found" };
  }

  const audit: CertificationAudit = {
    id: `cert_${randomUUID()}`,
    plugin_id,
    plugin_version: version,
    certification_tier: tier,
    status: "approved",
    reviewer_id,
    reviewer_name,
    security_score,
    performance_score,
    code_quality_score,
    test_coverage_percent: test_coverage,
    findings: [],
    certification_date: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  certifications.set(audit.id, audit);

  plugin.certification_status = "approved";
  plugin.certification_tier = tier;
  plugin.certification_date = new Date().toISOString();
  plugin.certified_by = reviewer_id;
  plugin.status = "certified";
  plugin.updated_at = new Date().toISOString();

  logAudit(
    plugin_id,
    "certified",
    reviewer_id,
    reviewer_name,
    "reviewer",
  );

  return { audit };
}

/**
 * Add finding to certification audit
 */
export function addCertificationFinding(
  audit_id: string,
  category: string,
  severity: "info" | "warning" | "critical",
  description: string,
): { audit: CertificationAudit; error?: string } {
  const audit = certifications.get(audit_id);
  if (!audit) {
    return { audit: {} as CertificationAudit, error: "Audit not found" };
  }

  audit.findings.push({
    category,
    severity,
    description,
    resolved: false,
  });
  audit.updated_at = new Date().toISOString();

  return { audit };
}

/**
 * Reject certification
 */
export function rejectCertification(
  plugin_id: string,
  reviewer_id: string,
  reviewer_name: string,
  reason: string,
): { plugin: Plugin; error?: string } {
  const plugin = plugins.get(plugin_id);
  if (!plugin) {
    return { plugin: {} as Plugin, error: "Plugin not found" };
  }

  plugin.certification_status = "rejected";
  plugin.status = "draft";
  plugin.updated_at = new Date().toISOString();

  logAudit(plugin_id, "rejected", reviewer_id, reviewer_name, "reviewer");

  return { plugin };
}

/**
 * Rollback plugin to previous version
 */
export function rollbackPlugin(
  plugin_id: string,
  from_version: string,
  to_version: string,
  reason: string,
  triggered_by: string,
): { rollback: PluginRollback; error?: string } {
  const plugin = plugins.get(plugin_id);
  if (!plugin) {
    return { rollback: {} as PluginRollback, error: "Plugin not found" };
  }

  const fromVer = plugin.versions.find((v) => v.version === from_version);
  const toVer = plugin.versions.find((v) => v.version === to_version);

  if (!fromVer || !toVer) {
    return { rollback: {} as PluginRollback, error: "Version not found" };
  }

  const rollback: PluginRollback = {
    id: `rollback_${randomUUID()}`,
    plugin_id,
    from_version,
    to_version,
    reason,
    triggered_by,
    triggered_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
  };

  rollbacks.set(rollback.id, rollback);
  plugin.current_version = to_version;
  plugin.updated_at = new Date().toISOString();

  logAudit(plugin_id, "yanked", triggered_by, triggered_by, "admin");

  return { rollback };
}

/**
 * Deprecate plugin version
 */
export function deprecateVersion(
  plugin_id: string,
  version: string,
): { pluginVersion: PluginVersion | null; error?: string } {
  const plugin = plugins.get(plugin_id);
  if (!plugin) {
    return { pluginVersion: null, error: "Plugin not found" };
  }

  const pluginVersion = plugin.versions.find((v) => v.version === version);
  if (!pluginVersion) {
    return { pluginVersion: null, error: "Version not found" };
  }

  pluginVersion.status = "deprecated";
  pluginVersion.deprecated_date = new Date().toISOString();
  plugin.updated_at = new Date().toISOString();

  return { pluginVersion };
}

/**
 * Search plugins in registry
 */
export function searchPlugins(query: PluginSearchQuery): { results: Plugin[]; total: number } {
  let filtered = Array.from(plugins.values()).filter((p) => p.status === "certified");

  if (query.query) {
    const q = query.query.toLowerCase();
    filtered = filtered.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        p.tags.some((t) => t.toLowerCase().includes(q)),
    );
  }

  if (query.category) {
    filtered = filtered.filter((p) => p.category === query.category);
  }

  if (query.certification_tier) {
    filtered = filtered.filter((p) => p.certification_tier === query.certification_tier);
  }

  const sorted = [...filtered].sort((a, b) => {
    switch (query.sort_by) {
      case "rating":
        return b.rating - a.rating;
      case "downloads":
        return b.downloads - a.downloads;
      case "recent":
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      case "trending":
        return b.rating_count - a.rating_count || b.downloads - a.downloads;
    }
  });

  const results = sorted.slice(query.offset, query.offset + query.limit);
  return { results, total: filtered.length };
}

/**
 * Get plugin
 */
export function getPlugin(plugin_id: string): { plugin: Plugin | null; error?: string } {
  const plugin = plugins.get(plugin_id);
  return { plugin: plugin || null, error: plugin ? undefined : "Plugin not found" };
}

/**
 * Get plugin version
 */
export function getPluginVersion(
  plugin_id: string,
  version: string,
): { pluginVersion: PluginVersion | null; error?: string } {
  const plugin = plugins.get(plugin_id);
  if (!plugin) {
    return { pluginVersion: null, error: "Plugin not found" };
  }

  const pluginVersion = plugin.versions.find((v) => v.version === version);
  return {
    pluginVersion: pluginVersion || null,
    error: pluginVersion ? undefined : "Version not found",
  };
}

/**
 * Add dependency
 */
export function addDependency(
  plugin_id: string,
  depends_on_plugin_id: string,
  version_constraint: string,
  is_optional: boolean = false,
): { dependency: PluginDependency; error?: string } {
  const depPlugin = plugins.get(depends_on_plugin_id);
  if (!depPlugin) {
    return { dependency: {} as PluginDependency, error: "Dependency plugin not found" };
  }

  const dependency: PluginDependency = {
    id: `dep_${randomUUID()}`,
    plugin_id,
    depends_on_plugin_id,
    depends_on_name: depPlugin.name,
    version_constraint,
    is_optional,
    created_at: new Date().toISOString(),
  };

  dependencies.set(dependency.id, dependency);
  return { dependency };
}

/**
 * Log audit event
 */
function logAudit(
  plugin_id: string,
  action: string,
  actor_id: string,
  actor_name: string,
  role: "developer" | "reviewer" | "admin",
): void {
  const log: RegistryAuditLog = {
    id: `audit_${randomUUID()}`,
    plugin_id,
    action,
    actor_id,
    actor_name,
    actor_role: role,
    details: {},
    timestamp: new Date().toISOString(),
    created_at: new Date().toISOString(),
  };

  auditLogs.set(log.id, log);
}

/**
 * Get audit logs for plugin
 */
export function getAuditLogs(plugin_id: string): { logs: RegistryAuditLog[] } {
  const logs = Array.from(auditLogs.values())
    .filter((log) => log.plugin_id === plugin_id)
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  return { logs };
}

/**
 * Get registry metrics
 */
export function getRegistryMetrics(): RegistryMetrics {
  const allPlugins = Array.from(plugins.values());
  const certified = allPlugins.filter((p) => p.status === "certified").length;
  const totalVersions = allPlugins.reduce((sum, p) => sum + p.versions.length, 0);
  const totalDownloads = allPlugins.reduce((sum, p) => sum + p.downloads, 0);
  const avgRating =
    allPlugins.length > 0
      ? allPlugins.reduce((sum, p) => sum + p.rating, 0) / allPlugins.length
      : 0;

  const byTier: Record<string, number> = { bronze: 0, silver: 0, gold: 0, platinum: 0 };
  const byStatus: Record<string, number> = {
    draft: 0,
    submitted: 0,
    certified: 0,
    deprecated: 0,
    blacklisted: 0,
  };

  allPlugins.forEach((p) => {
    byTier[p.certification_tier] = (byTier[p.certification_tier] || 0) + 1;
    byStatus[p.status] = (byStatus[p.status] || 0) + 1;
  });

  return {
    total_plugins: allPlugins.length,
    certified_plugins: certified,
    total_versions: totalVersions,
    total_downloads: totalDownloads,
    average_rating: avgRating,
    plugins_by_tier: byTier as any,
    plugins_by_status: byStatus as any,
    security_issues_count: 0,
    rollbacks_last_30_days: 0,
    average_time_to_certification_hours: 48,
  };
}

/**
 * Rate plugin
 */
export function ratePlugin(
  plugin_id: string,
  rating: number,
): { plugin: Plugin | null; error?: string } {
  const plugin = plugins.get(plugin_id);
  if (!plugin) {
    return { plugin: null, error: "Plugin not found" };
  }

  if (rating < 1 || rating > 5) {
    return { plugin: null, error: "Rating must be 1-5" };
  }

  const newTotal = plugin.rating * plugin.rating_count + rating;
  plugin.rating_count += 1;
  plugin.rating = newTotal / plugin.rating_count;
  plugin.updated_at = new Date().toISOString();

  return { plugin };
}
