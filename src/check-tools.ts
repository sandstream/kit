import type { ToolConfig } from "./config.js";
import { exec } from "./utils/exec.js";
import { resolveToolBin } from "./utils/resolveTool.js";

/** Resolve a tool name to its executable path (mise-first), or null. */
export type ToolResolver = (tool: string) => Promise<string | null>;

export interface ToolStatus {
  name: string;
  required: string;
  installed: string | null;
  ok: boolean;
}

async function getToolVersion(tool: string, resolve: ToolResolver): Promise<string | null> {
  // Fast path: `mise current` gives the project-pinned version directly when the
  // tool is declared in the project's mise config.
  try {
    const { stdout } = await exec("mise", ["current", tool], {
      timeout: 10_000,
    });
    const version = stdout.trim().split(/\s+/)[0];
    if (version) return version;
  } catch {
    // mise doesn't pin this tool in-project — fall through
  }

  // Resolve the binary mise-first, then read its version. `resolveToolBin` uses
  // `mise which` (which finds `mise use -g` globals even when mise isn't activated
  // in the shell, so its shims aren't on PATH) before falling back to PATH. Without
  // this, a globally mise-installed tool (e.g. semgrep/trivy) reports "not installed".
  const bin = await resolve(tool);
  if (!bin) return null;
  try {
    const { stdout: ver } = await exec(bin, ["--version"], {
      timeout: 10_000,
    });
    const match = ver.match(/(\d+[\d.]*)/);
    return match ? match[1] : "unknown";
  } catch {
    return null;
  }
}

function versionSatisfies(installed: string, required: string): boolean {
  if (required === "latest") return true;
  // Simple prefix match: required "22" matches "22.x.x", required "2.78" matches "2.78.x"
  return installed.startsWith(required);
}

export async function checkTools(
  tools: ToolConfig,
  resolve: ToolResolver = resolveToolBin,
): Promise<ToolStatus[]> {
  const results: ToolStatus[] = [];

  for (const [name, required] of Object.entries(tools)) {
    const installed = await getToolVersion(name, resolve);
    const ok = installed !== null && versionSatisfies(installed, required);
    results.push({ name, required, installed, ok });
  }

  return results;
}
