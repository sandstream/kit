import { writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { adapters } from "./adapters/index.js";
import { loadPluginAdapters } from "./plugin-loader.js";
import type { AdapterContext, ProvisionResult } from "./adapters/types.js";

/**
 * Load existing environment variables
 */
async function loadExistingEnv(projectPath: string): Promise<Record<string, string>> {
  try {
    const envPath = resolve(projectPath, ".env.local");
    const content = await readFile(envPath, "utf-8");
    
    const env: Record<string, string> = {};
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      
      const [key, ...valueParts] = trimmed.split("=");
      if (key && valueParts.length > 0) {
        env[key.trim()] = valueParts.join("=").trim();
      }
    }
    
    return env;
  } catch {
    return {};
  }
}

/**
 * Update .env.local with new secrets
 */
async function updateEnvFile(
  projectPath: string,
  secrets: Record<string, string>
): Promise<void> {
  const envPath = resolve(projectPath, ".env.local");
  const existing = await loadExistingEnv(projectPath);
  
  // Merge with existing
  const merged = { ...existing, ...secrets };
  
  // Write back
  const lines: string[] = [];
  for (const [key, value] of Object.entries(merged)) {
    lines.push(`${key}=${value}`);
  }
  
  await writeFile(envPath, lines.join("\n") + "\n", "utf-8");
}

/**
 * Update skills-lock.json with provisioning info
 */
async function updateSkillsLock(
  projectPath: string,
  serviceName: string,
  config: Record<string, unknown>
): Promise<void> {
  const lockPath = resolve(projectPath, "skills-lock.json");
  
  let lockData: any = { provisioned: {} };
  try {
    const content = await readFile(lockPath, "utf-8");
    lockData = JSON.parse(content);
  } catch {
    // File doesn't exist or parse error
  }
  
  if (!lockData.provisioned) {
    lockData.provisioned = {};
  }
  
  lockData.provisioned[serviceName] = {
    ...config,
    provisionedAt: new Date().toISOString(),
  };
  
  await writeFile(lockPath, JSON.stringify(lockData, null, 2) + "\n", "utf-8");
}

/**
 * Provision a service using the appropriate adapter
 */
export async function provisionService(
  serviceName: string,
  projectPath: string,
  projectName?: string
): Promise<ProvisionResult> {
  // Merge built-in adapters with any plugin adapters from kitPlugins in package.json
  const pluginAdapters = await loadPluginAdapters(projectPath);
  const allAdapters = { ...adapters, ...pluginAdapters };

  const adapter = allAdapters[serviceName];

  if (!adapter) {
    const available = Object.keys(allAdapters).join(", ");
    return {
      success: false,
      error: `Unknown service: ${serviceName}`,
      message: `Available services: ${available}`,
    };
  }
  
  // Check required tools
  const requiredTools = adapter.getRequiredTools();
  for (const tool of requiredTools) {
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const exec = promisify(execFile);
      await exec(tool, ["--version"], { timeout: 5_000 });
    } catch {
      return {
        success: false,
        error: `Required tool not installed: ${tool}`,
        message: `Install ${tool} before provisioning ${serviceName}`,
      };
    }
  }
  
  // Load context
  const existingEnv = await loadExistingEnv(projectPath);
  const context: AdapterContext = {
    projectPath,
    projectName,
    existingEnv,
  };
  
  // Check if already provisioned
  const alreadyProvisioned = await adapter.check(context);
  if (alreadyProvisioned) {
    return {
      success: true,
      message: `${serviceName} is already provisioned`,
      config: { alreadyProvisioned: true },
    };
  }
  
  // Provision the service
  const result = await adapter.provision(context);
  
  if (result.success) {
    // Update .env.local with secrets
    if (result.secrets && Object.keys(result.secrets).length > 0) {
      await updateEnvFile(projectPath, result.secrets);
    }
    
    // Update skills-lock.json with config
    if (result.config) {
      await updateSkillsLock(projectPath, serviceName, result.config);
    }
  }
  
  return result;
}

/**
 * List available services
 */
export function listAvailableServices(): string[] {
  return Object.keys(adapters);
}

/**
 * Get adapter info
 */
export function getServiceInfo(serviceName: string): { name: string; description: string; tools: string[] } | null {
  const adapter = adapters[serviceName];
  if (!adapter) return null;
  
  return {
    name: adapter.name,
    description: adapter.description,
    tools: adapter.getRequiredTools(),
  };
}
