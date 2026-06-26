import { readFile } from "node:fs/promises";
import { resolve, join, relative } from "node:path";
import type { AdapterRegistry, ServiceAdapter } from "./adapters/types.js";

// npm package-name grammar: optional single @scope/ prefix, then name.
// Rejects path-traversal payloads (`..`, `/`, `\`, leading `.`) because none of
// those bytes are in the allowed character class (only one scope slash permitted).
const PLUGIN_NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

/**
 * Validate a plugin name as a safe npm package specifier. Rejects anything that
 * could escape node_modules via path traversal (RCE vector).
 */
function isValidPluginName(name: string): boolean {
  if (typeof name !== "string" || name.length === 0 || name.length > 214) return false;
  if (name.includes("..") || name.includes("\\")) return false;
  if (name.startsWith(".") || name.startsWith("/")) return false;
  return PLUGIN_NAME_RE.test(name);
}

/**
 * Load plugin adapters from kitPlugins listed in the project's package.json.
 *
 * Plugin registration protocol:
 * 1. Read `kitPlugins` array from `<projectPath>/package.json`
 * 2. For each entry, attempt to import `<plugin>/kit-adapter` then `<plugin>`
 * 3. Expect the module to export `{ adapter: ServiceAdapter }` or `{ adapters: ServiceAdapter[] }`
 * 4. Invalid/missing plugins are skipped with a warning (never throw)
 *
 * @example package.json
 * ```json
 * { "kitPlugins": ["@acme/kit-railway", "sandstream-kit-plugin-aws-s3"] }
 * ```
 */
export async function loadPluginAdapters(projectPath: string): Promise<AdapterRegistry> {
  const registry: AdapterRegistry = {};

  const pluginNames = await readkitPlugins(projectPath);
  if (pluginNames.length === 0) return registry;

  for (const pluginName of pluginNames) {
    try {
      const adapters = await loadSinglePlugin(pluginName, projectPath);
      for (const adapter of adapters) {
        registry[adapter.name] = adapter;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[kit] plugin "${pluginName}" failed to load: ${msg}`);
    }
  }

  return registry;
}

/**
 * Read the kitPlugins array from package.json, returning [] if absent or unreadable.
 */
async function readkitPlugins(projectPath: string): Promise<string[]> {
  try {
    const pkgPath = resolve(projectPath, "package.json");
    const raw = await readFile(pkgPath, "utf-8");
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    const plugins = pkg["kitPlugins"];
    if (!Array.isArray(plugins)) return [];
    return plugins.filter((p): p is string => typeof p === "string");
  } catch {
    return [];
  }
}

/**
 * Attempt to load a plugin by name, trying `<plugin>/kit-adapter` first, then `<plugin>`.
 * Returns an array of ServiceAdapters or throws if both entry points fail.
 */
async function loadSinglePlugin(
  pluginName: string,
  projectPath: string,
): Promise<ServiceAdapter[]> {
  // Reject path-traversal / non-package names before they reach import() (RCE guard)
  if (!isValidPluginName(pluginName)) {
    throw new Error(`Invalid plugin name "${pluginName}" — not a valid npm package name`);
  }

  // Resolve the plugin from the project's node_modules (not kit's own node_modules)
  const nodeModules = resolve(projectPath, "node_modules");
  const candidates = [
    join(nodeModules, pluginName, "kit-adapter.js"),
    join(nodeModules, pluginName, "kit-adapter.cjs"),
    join(nodeModules, pluginName, "index.js"),
    join(nodeModules, pluginName),
  ];

  let mod: unknown;
  let lastError: unknown;

  for (const candidate of candidates) {
    // Defense in depth: never import anything that resolves outside node_modules
    const resolved = resolve(candidate);
    const rel = relative(nodeModules, resolved);
    if (rel.startsWith("..") || rel === "") {
      lastError = new Error(`Refusing to import "${candidate}" outside node_modules`);
      continue;
    }
    try {
      mod = await import(resolved);
      break;
    } catch (err) {
      lastError = err;
    }
  }

  if (mod === undefined) {
    const msg = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`Could not import "${pluginName}": ${msg}`);
  }

  return extractAdapters(mod, pluginName);
}

/**
 * Extract ServiceAdapter(s) from a loaded module, handling both single and array forms.
 */
function extractAdapters(mod: unknown, pluginName: string): ServiceAdapter[] {
  if (!mod || typeof mod !== "object") {
    throw new Error(`Plugin "${pluginName}" does not export an object`);
  }

  const exports = mod as Record<string, unknown>;

  // { adapters: ServiceAdapter[] }
  if (Array.isArray(exports["adapters"])) {
    const adapters = exports["adapters"].filter(isServiceAdapter);
    if (adapters.length > 0) return adapters;
  }

  // { adapter: ServiceAdapter }
  if (isServiceAdapter(exports["adapter"])) {
    return [exports["adapter"]];
  }

  // { default: { adapters } } or { default: ServiceAdapter }
  const def = exports["default"];
  if (def && typeof def === "object") {
    const d = def as Record<string, unknown>;
    if (Array.isArray(d["adapters"])) {
      const adapters = d["adapters"].filter(isServiceAdapter);
      if (adapters.length > 0) return adapters;
    }
    if (isServiceAdapter(def)) return [def as ServiceAdapter];
  }

  throw new Error(
    `Plugin "${pluginName}" must export { adapter } or { adapters } — got keys: ${Object.keys(exports).join(", ")}`,
  );
}

function isServiceAdapter(value: unknown): value is ServiceAdapter {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["name"] === "string" &&
    typeof v["description"] === "string" &&
    typeof v["check"] === "function" &&
    typeof v["provision"] === "function" &&
    typeof v["getRequiredTools"] === "function"
  );
}
