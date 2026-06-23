import { readFileSync } from "node:fs";
import { join } from "node:path";
import { detectStack } from "./stack-detector.js";
import { checkTools } from "./check-tools.js";
import { checkServices } from "./check-services.js";
import { checkSecrets } from "./check-secrets.js";
import { checkLockFiles } from "./check-lock.js";
import { resolveActiveEnvironment } from "./config.js";
import type { kitConfig } from "./config.js";

export interface ProjectContext {
  projectName: string;
  kitVersion: string;
  detectedStack: Awaited<ReturnType<typeof detectStack>>;
  activeEnvironment: string;
  tools: Array<{
    name: string;
    required: string | null;
    installed: string | null;
    ok: boolean;
  }>;
  services: Array<{
    name: string;
    authenticated: boolean;
    output?: string;
  }>;
  secrets: {
    templateExists: boolean | null;
    keys: Array<{
      name: string;
      available: boolean;
      detail?: string;
    }>;
  };
  locks: Array<{
    category: string;
    exists: boolean;
    inSync: boolean;
    detail: string;
  }>;
}

/**
 * Gather comprehensive project context for AI agents.
 * Reuses existing check functions to build a structured view of the project.
 */
export async function gatherProjectContext(
  config: kitConfig,
  cwd: string,
): Promise<ProjectContext> {
  const kitVersion = getkitVersion(cwd);
  const activeEnv = resolveActiveEnvironment();
  const stack = await detectStack(cwd);

  // Extract project name from package.json or use directory name
  let projectName = "unknown";
  try {
    const pkgPath = join(cwd, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { name?: string };
    projectName = pkg.name || "unknown";
  } catch {
    // Use fallback
  }

  // Gather tool checks
  const toolResults = config.tools ? await checkTools(config.tools) : [];
  const tools = toolResults.map((t) => ({
    name: t.name,
    required: t.required ?? null,
    installed: t.installed ?? null,
    ok: t.ok,
  }));

  // Gather service checks
  const serviceResults = config.services ? await checkServices(config.services) : [];
  const services = serviceResults.map((s) => ({
    name: s.name,
    authenticated: s.authenticated,
    output: s.output,
  }));

  // Gather secrets checks
  const secretResults = config.secrets
    ? await checkSecrets(config.secrets)
    : { templateExists: null, keys: [] };
  const secrets = {
    templateExists: secretResults.templateExists,
    keys: secretResults.keys.map((k) => ({
      name: k.name,
      available: k.available,
      detail: k.detail,
    })),
  };

  // Gather lock file checks
  const lockResults = await checkLockFiles(config);
  const locks = lockResults.map((l) => ({
    category: l.category,
    exists: l.exists,
    inSync: l.inSync,
    detail: l.detail,
  }));

  return {
    projectName,
    kitVersion,
    detectedStack: stack,
    activeEnvironment: activeEnv,
    tools,
    services,
    secrets,
    locks,
  };
}

/**
 * Get the current kit version from package.json.
 */
function getkitVersion(cwd: string): string {
  try {
    const pkgPath = join(cwd, "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}
