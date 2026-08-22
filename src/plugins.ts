/**
 * Plugin registry and management
 *
 * kit plugins are ServiceAdapter-based packages that can be discovered,
 * installed, and registered in .kit.toml. This module provides:
 * - Plugin registry search and discovery
 * - Plugin installation and configuration
 * - Metadata management
 */

import { exec } from "./utils/exec.js";
import { OFFICIAL_PLUGINS } from "./plugin-registry.generated.js";

/**
 * Plugin metadata as it appears in the registry
 */
export interface PluginMetadata {
  /** Unique identifier: provider/service (e.g., "stripe/payments") */
  name: string;
  /** Human-readable description */
  description: string;
  /** Plugin version */
  version: string;
  /** Plugin author */
  author: string;
  /** License SPDX identifier */
  license: string;
  /** Repository URL (for source discovery) */
  repository: string;
  /** npm package name (if published) */
  package?: string;
  /** Minimum kit version required */
  kitVersion: string;
  /** Array of tags for categorization */
  tags: string[];
  /**
   * Date published (ISO 8601), when a source for it exists.
   *
   * Optional because kit has no offline source for it: the previous hand-written registry filled
   * this in with a made-up date, alongside made-up ratings and download counts. A field kit cannot
   * substantiate is absent, not estimated.
   */
  published?: string;
  /** Download count in last 30 days */
  downloads?: number;
  /** Average rating (0-5 stars) */
  rating?: number;
  /** Installation instructions / command */
  install: string;
}

/**
 * Plugin registry — centralized list of available plugins
 */
export interface PluginRegistry {
  version: string;
  /**
   * When the registry was last updated, when that is knowable.
   *
   * Optional because the previous value was `new Date().toISOString()` evaluated at import — the
   * registry claimed to be current every time it was read, which is the same thing as claiming
   * nothing.
   */
  updated?: string;
  plugins: PluginMetadata[];
}

/**
 * kit's default plugin registry.
 *
 * Generated from the plugin packages that actually exist (see plugin-registry.generated.ts). The
 * hand-written table this replaces listed five of eleven shipped plugins, named npm packages that
 * were never published, pointed every repository link at a 404, and carried invented ratings and
 * download counts that `kit plugin list` rendered as `★★★★◆ 4.8`.
 */
export const DEFAULT_REGISTRY: PluginRegistry = {
  version: "2.0.0",
  plugins: OFFICIAL_PLUGINS,
};

/**
 * Search the plugin registry for matching plugins
 *
 * @param query - Search query (name, description, or tags)
 * @param registry - Plugin registry (uses default if not provided)
 * @returns Matching plugins sorted by relevance
 */
export function searchPlugins(
  query: string,
  registry: PluginRegistry = DEFAULT_REGISTRY,
): PluginMetadata[] {
  const q = query.toLowerCase();

  return registry.plugins
    .map((plugin) => {
      let score = 0;

      // Exact name match
      if (plugin.name.toLowerCase() === q) score += 1000;
      // Name prefix match
      if (plugin.name.toLowerCase().startsWith(q)) score += 500;
      // Name contains
      if (plugin.name.toLowerCase().includes(q)) score += 100;

      // Description match
      if (plugin.description.toLowerCase().includes(q)) score += 50;

      // Tag match
      if (plugin.tags.some((tag) => tag.toLowerCase().includes(q))) score += 75;

      return { plugin, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => {
      // Primary: relevance score
      if (b.score !== a.score) return b.score - a.score;
      // Secondary: download count
      return (b.plugin.downloads ?? 0) - (a.plugin.downloads ?? 0);
    })
    .map(({ plugin }) => plugin);
}

/**
 * List all plugins in the registry, optionally filtered by tag
 */
export function listPlugins(
  tag?: string,
  registry: PluginRegistry = DEFAULT_REGISTRY,
): PluginMetadata[] {
  if (!tag) {
    return registry.plugins.sort((a, b) => (b.downloads ?? 0) - (a.downloads ?? 0));
  }

  return registry.plugins
    .filter((plugin) => plugin.tags.includes(tag.toLowerCase()))
    .sort((a, b) => (b.downloads ?? 0) - (a.downloads ?? 0));
}

/**
 * Get detailed information about a single plugin
 */
export function getPluginInfo(
  name: string,
  registry: PluginRegistry = DEFAULT_REGISTRY,
): PluginMetadata | null {
  const normalized = name.toLowerCase();
  return registry.plugins.find((p) => p.name.toLowerCase() === normalized) || null;
}

/**
 * Get all unique tags in the registry
 */
export function getAllTags(registry: PluginRegistry = DEFAULT_REGISTRY): string[] {
  const tags = new Set<string>();
  for (const plugin of registry.plugins) {
    for (const tag of plugin.tags) {
      tags.add(tag);
    }
  }
  return Array.from(tags).sort();
}

/**
 * Format a plugin for display in CLI output
 */
export function formatPluginForDisplay(plugin: PluginMetadata, detailed: boolean = false): string {
  const lines: string[] = [];

  // Header line: name, version, rating
  const ratingStr = plugin.rating ? ` ${formatStars(plugin.rating)}` : "";
  lines.push(`  ${plugin.name} ${plugin.version}${ratingStr}`);

  // Description
  lines.push(`    ${plugin.description}`);

  if (detailed) {
    // Author and license
    lines.push(`    Author: ${plugin.author} | License: ${plugin.license}`);

    // Tags
    if (plugin.tags.length > 0) {
      lines.push(`    Tags: ${plugin.tags.join(", ")}`);
    }

    // Downloads
    if (plugin.downloads !== undefined) {
      lines.push(`    Downloads: ${plugin.downloads.toLocaleString()} (last 30 days)`);
    }

    // Installation command
    lines.push(`    Install: ${plugin.install}`);

    // Repository
    lines.push(`    Repository: ${plugin.repository}`);
  }

  return lines.join("\n");
}

/**
 * Format a numeric rating (0-5) as star display
 */
function formatStars(rating: number): string {
  const full = Math.floor(rating);
  const half = rating - full >= 0.5 ? 1 : 0;
  const empty = 5 - full - half;

  return "★".repeat(full) + (half ? "◆" : "") + "☆".repeat(empty) + ` ${rating.toFixed(1)}`;
}

/**
 * Check if a plugin is installed by attempting to require/import it
 */
export async function isPluginInstalled(packageName: string): Promise<boolean> {
  try {
    const result = await exec("npm", ["ls", packageName, "--depth=0"], {
      timeout: 5000,
    });
    return result.stdout.includes(packageName);
  } catch {
    return false;
  }
}

/**
 * Install a plugin via npm
 */
export async function installPlugin(
  pluginName: string,
  metadata: PluginMetadata,
): Promise<{ success: boolean; message: string }> {
  try {
    // Use npm to install the package
    const packageName = metadata.package || pluginName;
    const cmd = metadata.install;

    // Extract the actual npm install command
    const match = cmd.match(/npm install (.+)/);
    const pkgToInstall = match ? match[1] : packageName;

    const { stderr } = await exec("npm", ["install", pkgToInstall], {
      timeout: 60000,
    });

    if (stderr && stderr.includes("ERR!")) {
      return {
        success: false,
        message: `Installation failed: ${stderr}`,
      };
    }

    return {
      success: true,
      message: `Installed ${pluginName} (${metadata.version})`,
    };
  } catch (err: unknown) {
    const error = err as { message?: string; stderr?: string };
    return {
      success: false,
      message: `Installation error: ${error.message || error.stderr || String(err)}`,
    };
  }
}
