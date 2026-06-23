import type { ServiceConfig } from "./config.js";
import { parseCommand } from "./utils/parseCommand.js";
import { redactSecrets } from "./utils/redactSecrets.js";
import { exec } from "./utils/exec.js";
import { resolveToolBin } from "./utils/resolveTool.js";

export interface ServiceStatus {
  name: string;
  checkCommand: string;
  authenticated: boolean;
  output: string;
  /** True when the check command is documentation only ("#"-prefixed). */
  informational?: boolean;
}

async function runCheck(
  command: string,
): Promise<{ ok: boolean; output: string; informational?: boolean }> {
  const parsed = parseCommand(command);
  if (parsed.kind === "informational") {
    return { ok: false, output: parsed.message, informational: true };
  }
  try {
    // Resolve the CLI mise-first so a service tool installed via `mise use -g`
    // (stripe, vercel, supabase, …) is found even when mise isn't activated in
    // the shell; fall back to the bare name for non-mise installs.
    const bin = (await resolveToolBin(parsed.cmd)) ?? parsed.cmd;
    const { stdout, stderr } = await exec(bin, parsed.args, {
      timeout: 15_000,
      env: { ...process.env },
    });
    return { ok: true, output: redactSecrets((stdout || stderr).trim()) };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, output: redactSecrets(message.split("\n")[0]) };
  }
}

export async function checkServices(
  services: Record<string, ServiceConfig>,
): Promise<ServiceStatus[]> {
  const results: ServiceStatus[] = [];

  for (const [name, config] of Object.entries(services)) {
    if (!config.check) {
      results.push({
        name,
        checkCommand: "(no check command)",
        authenticated: false,
        output: "No check command configured",
      });
      continue;
    }

    const { ok, output, informational } = await runCheck(config.check);
    results.push({
      name,
      checkCommand: config.check,
      authenticated: ok,
      output,
      ...(informational ? { informational: true } : {}),
    });
  }

  return results;
}
