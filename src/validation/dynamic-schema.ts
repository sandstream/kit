import { z } from "zod";
import type { PluginRegistry } from "../plugin-registry.js";

/**
 * Create a dynamic Zod schema for web_search provider validation
 * that includes both built-in and plugin-registered providers
 */
export function createWebSearchProviderSchema(
  registry?: PluginRegistry,
): z.ZodType<string> {
  const builtInProviders = ["brave", "google", "searxng", "custom"];

  let providers = builtInProviders;

  if (registry) {
    const pluginProviders = Array.from(registry.getWebSearchProviders().keys());
    providers = Array.from(new Set([...builtInProviders, ...pluginProviders]));
  }

  return z.enum(providers as [string, ...string[]]);
}

/**
 * Create a dynamic schema for web search configuration
 * that validates provider names against registered plugins
 */
export function createWebSearchConfigSchema(
  registry?: PluginRegistry,
): z.ZodType<{ provider?: string; url?: string; apiKey?: string }> {
  const providerSchema = createWebSearchProviderSchema(registry);

  return z
    .object({
      provider: providerSchema.optional(),
      url: z.string().url().optional(),
      apiKey: z.string().optional(),
    })
    .strict()
    .refine(
      (data) => {
        // If provider is set, validate it makes sense
        if (!data.provider) {
          return true;
        }

        // SearXNG requires a URL
        if (data.provider === "searxng" && !data.url) {
          return false;
        }

        // Brave requires an API key
        if (data.provider === "brave" && !data.apiKey) {
          return false;
        }

        return true;
      },
      {
        message:
          "SearXNG requires 'url' and Brave requires 'apiKey' configuration",
      },
    );
}

/**
 * Validate web search configuration
 * Returns validation result with error messages if validation fails
 */
export interface ValidationResult {
  valid: boolean;
  errors?: string[];
}

export function validateWebSearchConfig(
  config: unknown,
  registry?: PluginRegistry,
): ValidationResult {
  const schema = createWebSearchConfigSchema(registry);

  try {
    schema.parse(config);
    return { valid: true };
  } catch (err) {
    if (err instanceof z.ZodError) {
      return {
        valid: false,
        errors: err.issues.map(
          (issue) => `${issue.path.join(".")}: ${issue.message}`,
        ),
      };
    }
    return {
      valid: false,
      errors: [err instanceof Error ? err.message : "Unknown validation error"],
    };
  }
}

/**
 * Get all valid provider names as a string list
 */
export function getValidProviderNames(registry?: PluginRegistry): string[] {
  const builtInProviders = ["brave", "google", "searxng", "custom"];

  if (!registry) {
    return builtInProviders;
  }

  const pluginProviders = Array.from(registry.getWebSearchProviders().keys());
  return Array.from(new Set([...builtInProviders, ...pluginProviders]));
}
