import type { ToolConfig } from "./config.js";
import { checkTools, type ToolStatus } from "./check-tools.js";
import { exec } from "./utils/exec.js";


export interface InstallResult {
  name: string;
  action: "installed" | "already_ok" | "failed";
  detail: string;
}

async function miseInstall(
  tool: string,
  version: string,
): Promise<{ ok: boolean; detail: string }> {
  const versionArg = version === "latest" ? "latest" : version;
  try {
    await exec("mise", ["install", `${tool}@${versionArg}`], {
      timeout: 120_000,
      env: { ...process.env },
    });
    // Activate the tool in the current project
    await exec("mise", ["use", `${tool}@${versionArg}`], {
      timeout: 30_000,
      env: { ...process.env },
    });
    return { ok: true, detail: `Installed ${tool}@${versionArg} via mise` };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: message.split("\n")[0] };
  }
}

export interface InstallDeps {
  checkTools: (tools: ToolConfig) => Promise<ToolStatus[]>;
  miseInstall: (tool: string, version: string) => Promise<{ ok: boolean; detail: string }>;
}

const defaultDeps: InstallDeps = { checkTools, miseInstall };

export async function installTools(
  tools: ToolConfig,
  deps: InstallDeps = defaultDeps,
): Promise<InstallResult[]> {
  const statuses = await deps.checkTools(tools);
  const results: InstallResult[] = [];

  for (const status of statuses) {
    if (status.ok) {
      results.push({
        name: status.name,
        action: "already_ok",
        detail: `${status.installed} satisfies ${status.required}`,
      });
      continue;
    }

    const { ok, detail } = await deps.miseInstall(status.name, status.required);
    if (!ok) {
      results.push({ name: status.name, action: "failed", detail });
      continue;
    }

    // Re-check that installed version satisfies requirement
    const [verified] = await deps.checkTools({ [status.name]: status.required });
    if (verified.ok) {
      results.push({
        name: status.name,
        action: "installed",
        detail: `${verified.installed} satisfies ${status.required}`,
      });
    } else {
      results.push({
        name: status.name,
        action: "failed",
        detail: `Installed ${verified.installed ?? "unknown"} but need ${status.required}`,
      });
    }
  }

  return results;
}
