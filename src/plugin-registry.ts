import type { SkillsLockFile } from "./skills.js";

/**
 * Capability metadata that a plugin can expose
 */
export interface PluginCapability {
  name: string;
  type: "web_search_provider" | "tool" | "secret_store" | "service" | string;
  version: string;
  config?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/**
 * Plugin manifest that describes what a plugin provides
 */
export interface PluginManifest {
  name: string;
  version: string;
  capabilities: PluginCapability[];
}

/**
 * Registry for dynamically discovering plugin capabilities
 */
export class PluginRegistry {
  private capabilities: Map<string, PluginCapability[]> = new Map();

  /**
   * Register a plugin with its capabilities
   */
  registerPlugin(plugin: PluginManifest): void {
    const key = `${plugin.name}@${plugin.version}`;
    this.capabilities.set(key, plugin.capabilities);
  }

  /**
   * Get all web_search providers from registered plugins
   */
  getWebSearchProviders(): Map<string, PluginCapability> {
    const providers = new Map<string, PluginCapability>();

    for (const capabilities of this.capabilities.values()) {
      for (const capability of capabilities) {
        if (capability.type === "web_search_provider") {
          providers.set(capability.name, capability);
        }
      }
    }

    return providers;
  }

  /**
   * Get all capabilities of a specific type
   */
  getCapabilitiesByType(type: string): Map<string, PluginCapability> {
    const result = new Map<string, PluginCapability>();

    for (const capabilities of this.capabilities.values()) {
      for (const capability of capabilities) {
        if (capability.type === type) {
          result.set(capability.name, capability);
        }
      }
    }

    return result;
  }

  /**
   * Check if a provider is registered
   */
  hasProvider(name: string): boolean {
    const providers = this.getWebSearchProviders();
    return providers.has(name);
  }

  /**
   * Get a specific provider capability
   */
  getProvider(name: string): PluginCapability | undefined {
    const providers = this.getWebSearchProviders();
    return providers.get(name);
  }

  /**
   * Clear all registered capabilities
   */
  clear(): void {
    this.capabilities.clear();
  }
}

/**
 * Create a plugin registry from a skills lock file
 * This discovers plugin capabilities from the skills-lock.json
 */
export function createRegistryFromSkillsLock(skillsLock: SkillsLockFile): PluginRegistry {
  const registry = new PluginRegistry();

  // For now, we'll create a basic registry structure.
  // In a real implementation, this would:
  // 1. Load plugin manifests from the ClawhHub registry
  // 2. Parse plugin capability declarations
  // 3. Register them with the registry

  // As a starting point, we'll support some known plugin patterns:
  // - searxng skill as a web_search_provider

  for (const [skillName, skillEntry] of Object.entries(skillsLock.skills)) {
    if (skillName.includes("searxng")) {
      // Register SearXNG as a web_search_provider if it's in the skills
      const plugin: PluginManifest = {
        name: skillName,
        version: skillEntry.version,
        capabilities: [
          {
            name: "searxng",
            type: "web_search_provider",
            version: skillEntry.version,
            config: {
              url: "http://localhost:8080",
            },
          },
        ],
      };
      registry.registerPlugin(plugin);
    }
  }

  return registry;
}

/**
 * Get all valid web_search provider names (both built-in and plugin-registered)
 */
export function getValidWebSearchProviders(registry?: PluginRegistry): string[] {
  const builtIn = ["brave", "google", "searxng", "custom"];

  if (!registry) {
    return builtIn;
  }

  const pluginProviders = Array.from(registry.getWebSearchProviders().keys());
  return Array.from(new Set([...builtIn, ...pluginProviders]));
}
