/**
 * Plugin registry and management
 *
 * kit plugins are published packages that can be discovered and installed.
 * ServiceAdapter packages additionally register in project package.json. This module provides:
 * - Plugin registry search and discovery
 * - Plugin installation and configuration
 * - Metadata management
 */

import { exec } from "./utils/exec.js";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { OFFICIAL_PLUGINS } from "./plugin-registry.generated.js";
import { gateInstall } from "./triage-gate.js";
import { isRegistrySpec } from "./triage-sandbox.js";

/**
 * Plugin metadata as it appears in the registry
 */
export interface PluginMetadata {
  /** Registry ID (e.g., "stripe" or "railway") */
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
  /** ServiceAdapter name exported by this package, when it is a `kit add` adapter. */
  adapter?: string;
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

export interface PluginInstallDeps {
  gateInstall: typeof gateInstall;
  exec(
    command: string,
    args: readonly string[],
    options?: { cwd?: string; timeout?: number },
  ): Promise<{ stdout: string; stderr: string }>;
}

const defaultInstallDeps: PluginInstallDeps = { gateInstall, exec };

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
    lines.push(
      plugin.adapter
        ? `    Integration: kit add ${plugin.adapter} (registered in package.json kitPlugins)`
        : "    Integration: package API; no kit add adapter",
    );

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

function registryInstallSpec(installCommand: string): string {
  const match = installCommand.trim().match(/^npm\s+install\s+(\S+)$/);
  const declaredSpec = match?.[1] ?? "";
  if (!isRegistrySpec(declaredSpec)) {
    throw new Error(`Refusing non-registry plugin package spec: ${declaredSpec || installCommand}`);
  }
  return declaredSpec;
}

/** Install a plugin via npm using the exact registry package/version. */
function pinnedPluginSpec(pluginName: string, metadata: PluginMetadata): string {
  const packageName = metadata.package || pluginName;
  const declaredSpec = registryInstallSpec(metadata.install);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(metadata.version)) {
    throw new Error(`Invalid exact plugin version: ${metadata.version}`);
  }
  const pinned = `${packageName}@${metadata.version}`;
  if (!isRegistrySpec(pinned) || (declaredSpec !== packageName && declaredSpec !== pinned)) {
    throw new Error(`Registry install spec ${declaredSpec} disagrees with ${pinned}`);
  }
  return pinned;
}

export async function installPlugin(
  pluginName: string,
  metadata: PluginMetadata,
  deps: PluginInstallDeps = defaultInstallDeps,
  cwd: string = process.cwd(),
): Promise<{ success: boolean; message: string }> {
  try {
    const pkgToInstall = pinnedPluginSpec(pluginName, metadata);
    if (metadata.adapter) await readPluginManifest(cwd);
    const verdict = await deps.gateInstall(`npm:${pkgToInstall}`);
    if (verdict.decision === "blocked") {
      return {
        success: false,
        message: `Triage blocked installation: ${verdict.reason}`,
      };
    }

    const { stderr } = await deps.exec("npm", ["install", "--save-exact", pkgToInstall], {
      timeout: 60000,
      cwd,
    });

    if (stderr && stderr.includes("ERR!")) {
      return {
        success: false,
        message: `Installation failed: ${stderr}`,
      };
    }

    if (metadata.adapter) await registerInstalledPluginAdapter(metadata, cwd);
    return {
      success: true,
      message: metadata.adapter
        ? `Installed ${pluginName} (${metadata.version}); registered ${metadata.package || pluginName} in package.json kitPlugins. Run kit add ${metadata.adapter}.`
        : `Installed ${pluginName} (${metadata.version}); package API only, no kit add adapter. See the package README for usage.`,
    };
  } catch (err: unknown) {
    const error = err as { message?: string; stderr?: string };
    return {
      success: false,
      message: `Installation error: ${error.message || error.stderr || String(err)}`,
    };
  }
}

async function readPluginManifest(
  cwd: string,
): Promise<{ path: string; data: Record<string, unknown> }> {
  const path = resolve(cwd, "package.json");
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("Adapter installation requires a project package.json; run npm init first", {
        cause: error,
      });
    }
    throw error;
  }
  const data = JSON.parse(raw) as unknown;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Project package.json must be an object to register an adapter");
  }
  const plugins = (data as Record<string, unknown>)["kitPlugins"];
  if (
    plugins !== undefined &&
    (!Array.isArray(plugins) || !plugins.every((name) => typeof name === "string"))
  ) {
    throw new Error("Project package.json kitPlugins must be an array of package names");
  }
  return { path, data: data as Record<string, unknown> };
}

/** Register an already installed ServiceAdapter; safe to call again on repeat installs. */
export async function registerInstalledPluginAdapter(
  metadata: PluginMetadata,
  cwd: string = process.cwd(),
): Promise<boolean> {
  if (!metadata.adapter) return false;
  const { path, data } = await readPluginManifest(cwd);
  const packageName = metadata.package ?? metadata.name;
  const plugins = (data["kitPlugins"] as string[] | undefined) ?? [];
  if (plugins.includes(packageName)) return false;
  const next = { ...data, kitPlugins: [...plugins, packageName] };
  const tmp = resolve(
    dirname(path),
    `.package.json.kit-plugin-${process.pid}-${Math.random().toString(36).slice(2)}`,
  );
  try {
    const mode = (await stat(path)).mode & 0o777;
    await writeFile(tmp, JSON.stringify(next, null, 2) + "\n", { encoding: "utf-8", mode });
    await rename(tmp, path);
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
  return true;
}
