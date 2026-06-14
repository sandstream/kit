/**
 * kit Plugin Update Infrastructure
 *
 * Manages plugin version checking, updates, and dependency resolution
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

/**
 * Plugin version information
 */
export interface PluginVersion {
  id: string;
  version: string;
  published: string;
  deprecated?: boolean;
  breaking?: boolean;
  features: string[];
  bugFixes: string[];
  securityFixes?: string[];
}

/**
 * Available update for a plugin
 */
export interface PluginUpdate {
  currentVersion: string;
  latestVersion: string;
  isBreaking: boolean;
  isSecurityFix: boolean;
  availableVersions: PluginVersion[];
  changelog: string;
  installCommand: string;
}

/**
 * Plugin with installed version
 */
export interface InstalledPlugin {
  id: string;
  name: string;
  version: string;
  installed: string;
  dependencies: Record<string, string>;
}

/**
 * Version comparison result
 */
export interface VersionComparison {
  isNewer: boolean;
  isBreaking: boolean;
  isMajor: boolean;
  isMinor: boolean;
  isPatch: boolean;
}

/**
 * Plugin Updates Manager
 */
export class PluginUpdatesManager {
  private versionsFile: string;
  private installedFile: string;
  private lockFile: string;
  private versionsCache: PluginVersion[] | null = null;
  private installedCache: InstalledPlugin[] | null = null;

  constructor(dataDir: string = ".kit/plugins") {
    this.versionsFile = join(dataDir, "versions.json");
    this.installedFile = join(dataDir, "installed.json");
    this.lockFile = join(dataDir, "lock.json");
  }

  /**
   * Set versions cache for testing
   */
  setVersionsCache(versions: PluginVersion[]): void {
    this.versionsCache = versions;
  }

  /**
   * Set installed cache for testing
   */
  setInstalledCache(plugins: InstalledPlugin[]): void {
    this.installedCache = plugins;
  }

  /**
   * Parse semantic version string
   */
  private parseVersion(version: string): {
    major: number;
    minor: number;
    patch: number;
  } {
    // Handle various version formats: 1.2.3, v1.2.3, ^1.2.3, ~1.2.3
    const match = version.match(/(\d+)\.(\d+)\.(\d+)/);
    if (!match) {
      return { major: 0, minor: 0, patch: 0 };
    }
    return {
      major: parseInt(match[1]),
      minor: parseInt(match[2]),
      patch: parseInt(match[3]),
    };
  }

  /**
   * Compare two semantic versions
   */
  private compareVersions(v1: string, v2: string): VersionComparison {
    const ver1 = this.parseVersion(v1);
    const ver2 = this.parseVersion(v2);

    const isNewer =
      ver2.major > ver1.major ||
      (ver2.major === ver1.major && ver2.minor > ver1.minor) ||
      (ver2.major === ver1.major &&
        ver2.minor === ver1.minor &&
        ver2.patch > ver1.patch);

    const isMajor = ver2.major > ver1.major;
    const isMinor = ver2.major === ver1.major && ver2.minor > ver1.minor;
    const isPatch =
      ver2.major === ver1.major && ver2.minor === ver1.minor && ver2.patch > ver1.patch;

    return {
      isNewer,
      isBreaking: isMajor,
      isMajor,
      isMinor,
      isPatch,
    };
  }

  /**
   * Version matches requirement (^, ~, >=, etc.)
   */
  private versionMatches(requirement: string, version: string): boolean {
    if (requirement === "*" || requirement === "latest") return true;

    const ver = this.parseVersion(version);
    const req = this.parseVersion(requirement);

    if (requirement.startsWith("^")) {
      // Caret: allows changes that do not modify left-most non-zero digit
      return (
        ver.major === req.major &&
        (ver.minor > req.minor ||
          (ver.minor === req.minor && ver.patch >= req.patch))
      );
    }

    if (requirement.startsWith("~")) {
      // Tilde: allows patch-level changes
      return (
        ver.major === req.major &&
        ver.minor === req.minor &&
        ver.patch >= req.patch
      );
    }

    if (requirement.startsWith(">=")) {
      const minVersion = requirement.slice(2).trim();
      const min = this.parseVersion(minVersion);
      return (
        ver.major > min.major ||
        (ver.major === min.major && ver.minor > min.minor) ||
        (ver.major === min.major &&
          ver.minor === min.minor &&
          ver.patch >= min.patch)
      );
    }

    // Exact match
    return version === requirement;
  }

  /**
   * Check for updates for installed plugins
   */
  checkForUpdates(
    plugins: InstalledPlugin[],
  ): Record<string, PluginUpdate | null> {
    const versions = this.getAllVersions();
    const updates: Record<string, PluginUpdate | null> = {};

    plugins.forEach((plugin) => {
      const pluginVersions = versions.filter((v) => v.id === plugin.id);

      if (pluginVersions.length === 0) {
        updates[plugin.id] = null;
        return;
      }

      // Sort by version descending
      pluginVersions.sort((a, b) => {
        const cmp = this.compareVersions(a.version, b.version);
        return cmp.isNewer ? -1 : 1;
      });

      const latestVersion = pluginVersions[0];

      if (
        this.compareVersions(plugin.version, latestVersion.version).isNewer
      ) {
        updates[plugin.id] = {
          currentVersion: plugin.version,
          latestVersion: latestVersion.version,
          isBreaking: latestVersion.breaking || false,
          isSecurityFix: (latestVersion.securityFixes || []).length > 0,
          availableVersions: pluginVersions.filter((v) =>
            this.compareVersions(plugin.version, v.version).isNewer,
          ),
          changelog: this.generateChangelog(
            plugin.id,
            plugin.version,
            latestVersion.version,
          ),
          installCommand: `kit add ${plugin.id}@${latestVersion.version}`,
        };
      } else {
        updates[plugin.id] = null;
      }
    });

    return updates;
  }

  /**
   * Resolve plugin dependencies
   */
  resolveDependencies(
    pluginId: string,
    version: string,
  ): {
    resolved: Record<string, string>;
    conflicts: Array<{ plugin: string; required: string; installed: string }>;
    unmet: Array<{ plugin: string; required: string }>;
  } {
    const versions = this.getAllVersions();
    const installed = this.getInstalledPlugins();

    const pluginVersion = versions.find(
      (v) => v.id === pluginId && v.version === version,
    );

    if (!pluginVersion) {
      return { resolved: {}, conflicts: [], unmet: [] };
    }

    const resolved: Record<string, string> = {};
    const conflicts: Array<{
      plugin: string;
      required: string;
      installed: string;
    }> = [];
    const unmet: Array<{ plugin: string; required: string }> = [];

    // Resolve each dependency
    Object.entries(pluginVersion.features || {}).forEach(
      ([depId, depRequirement]) => {
        const availableVersions = versions.filter((v) => v.id === depId);

        if (availableVersions.length === 0) {
          unmet.push({ plugin: depId, required: depRequirement as string });
          return;
        }

        // Find compatible version
        const compatible = availableVersions.find((v) =>
          this.versionMatches(depRequirement as string, v.version),
        );

        if (!compatible) {
          unmet.push({ plugin: depId, required: depRequirement as string });
          return;
        }

        const installedPlugin = installed.find((p) => p.id === depId);

        if (installedPlugin && installedPlugin.version !== compatible.version) {
          conflicts.push({
            plugin: depId,
            required: compatible.version,
            installed: installedPlugin.version,
          });
        }

        resolved[depId] = compatible.version;
      },
    );

    return { resolved, conflicts, unmet };
  }

  /**
   * Get upgrade path from current to target version
   */
  getUpgradePath(
    pluginId: string,
    fromVersion: string,
    toVersion: string,
  ): PluginVersion[] {
    const versions = this.getAllVersions()
      .filter((v) => v.id === pluginId)
      .sort((a, b) => {
        const aVer = this.parseVersion(a.version);
        const bVer = this.parseVersion(b.version);
        return (
          aVer.major * 1000 +
          aVer.minor * 100 +
          aVer.patch -
          (bVer.major * 1000 + bVer.minor * 100 + bVer.patch)
        );
      });

    const fromIdx = versions.findIndex((v) => v.version === fromVersion);
    const toIdx = versions.findIndex((v) => v.version === toVersion);

    if (fromIdx < 0 || toIdx < 0) {
      return [];
    }

    return versions.slice(fromIdx + 1, toIdx + 1);
  }

  /**
   * Check for security updates
   */
  getSecurityUpdates(plugins: InstalledPlugin[]): Array<{
    plugin: InstalledPlugin;
    update: PluginUpdate;
    severity: "critical" | "high" | "medium" | "low";
  }> {
    const updates = this.checkForUpdates(plugins);
    const securityUpdates = [];

    for (const plugin of plugins) {
      const update = updates[plugin.id];
      if (update?.isSecurityFix) {
        const severity = update.isBreaking ? "critical" : "high";
        securityUpdates.push({
          plugin,
          update,
          severity: severity as "critical" | "high",
        });
      }
    }

    return securityUpdates;
  }

  /**
   * Rollback plugin to previous version
   */
  rollback(
    pluginId: string,
    fromVersion: string,
  ): {
    previousVersion: string | null;
    rollbackCommand: string | null;
  } {
    const versions = this.getAllVersions()
      .filter((v) => v.id === pluginId)
      .sort((a, b) => {
        const aVer = this.parseVersion(a.version);
        const bVer = this.parseVersion(b.version);
        return (
          bVer.major * 1000 +
          bVer.minor * 100 +
          bVer.patch -
          (aVer.major * 1000 + aVer.minor * 100 + aVer.patch)
        );
      });

    const currentIdx = versions.findIndex((v) => v.version === fromVersion);
    if (currentIdx < 0 || currentIdx >= versions.length - 1) {
      return { previousVersion: null, rollbackCommand: null };
    }

    const previousVersion = versions[currentIdx + 1];
    return {
      previousVersion: previousVersion.version,
      rollbackCommand: `kit add ${pluginId}@${previousVersion.version}`,
    };
  }

  /**
   * Generate changelog between versions
   */
  private generateChangelog(
    pluginId: string,
    fromVersion: string,
    toVersion: string,
  ): string {
    const upgradePath = this.getUpgradePath(pluginId, fromVersion, toVersion);

    if (upgradePath.length === 0) {
      return "No changelog available";
    }

    let changelog = `# Changelog: ${pluginId} ${fromVersion} → ${toVersion}\n\n`;

    upgradePath.forEach((version) => {
      changelog += `## ${version.version}\n`;
      changelog += `*Published: ${version.published}*\n\n`;

      if (version.breaking) {
        changelog += "⚠️ **Breaking Changes**\n";
      }

      if ((version.securityFixes || []).length > 0) {
        changelog += "🔒 **Security Fixes**\n";
        version.securityFixes?.forEach((fix) => {
          changelog += `- ${fix}\n`;
        });
        changelog += "\n";
      }

      if (version.features.length > 0) {
        changelog += "✨ **Features**\n";
        version.features.forEach((feature) => {
          changelog += `- ${feature}\n`;
        });
        changelog += "\n";
      }

      if (version.bugFixes.length > 0) {
        changelog += "🐛 **Bug Fixes**\n";
        version.bugFixes.forEach((fix) => {
          changelog += `- ${fix}\n`;
        });
        changelog += "\n";
      }
    });

    return changelog;
  }

  /**
   * Get all plugin versions
   */
  private getAllVersions(): PluginVersion[] {
    // Use cache if available (for testing)
    if (this.versionsCache !== null) {
      return this.versionsCache;
    }

    try {
      const data = readFileSync(this.versionsFile, "utf-8");
      return JSON.parse(data);
    } catch {
      return [];
    }
  }

  /**
   * Get installed plugins
   */
  private getInstalledPlugins(): InstalledPlugin[] {
    // Use cache if available (for testing)
    if (this.installedCache !== null) {
      return this.installedCache;
    }

    try {
      const data = readFileSync(this.installedFile, "utf-8");
      return JSON.parse(data);
    } catch {
      return [];
    }
  }

  /**
   * Update installed plugins lock
   */
  updateLock(plugins: InstalledPlugin[]): void {
    const lock = {
      timestamp: new Date().toISOString(),
      plugins: plugins.map((p) => ({
        id: p.id,
        version: p.version,
        installed: p.installed,
      })),
    };
    writeFileSync(this.lockFile, JSON.stringify(lock, null, 2));
  }
}
