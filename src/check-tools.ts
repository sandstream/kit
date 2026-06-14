import type { ToolConfig } from "./config.js";
import { exec } from "./utils/exec.js";


export interface ToolStatus {
  name: string;
  required: string;
  installed: string | null;
  ok: boolean;
}

async function getToolVersion(tool: string): Promise<string | null> {
  // Try mise first
  try {
    const { stdout } = await exec("mise", ["current", tool], {
      timeout: 10_000,
    });
    const version = stdout.trim().split(/\s+/)[0];
    if (version) return version;
  } catch {
    // mise doesn't manage this tool — fall through
  }

  // Fallback: check if tool exists on PATH and get its version
  try {
    const { stdout: ver } = await exec(tool, ["--version"], {
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
): Promise<ToolStatus[]> {
  const results: ToolStatus[] = [];

  for (const [name, required] of Object.entries(tools)) {
    const installed = await getToolVersion(name);
    const ok = installed !== null && versionSatisfies(installed, required);
    results.push({ name, required, installed, ok });
  }

  return results;
}
