import { basename } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { ServiceConfig } from "./config.js";
import { checkInfisicalStatus, isInfisicalLoginStatus } from "./infisical-status.js";
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

function isInfisicalHelp(output: string): boolean {
  const plain = stripVTControlCharacters(output);
  return /^Usage:\s*\r?\n[ \t]+infisical(?:[ \t]|\r?$)/m.test(plain) && /^Flags:/m.test(plain);
}

async function runCheck(
  command: string,
  cwd: string,
): Promise<{ ok: boolean; output: string; informational?: boolean }> {
  const parsed = parseCommand(command);
  if (parsed.kind === "informational") {
    return { ok: false, output: parsed.message, informational: true };
  }
  const infisical = /^infisical(?:\.exe)?$/i.test(basename(parsed.cmd));
  if (infisical && isInfisicalLoginStatus(parsed.args)) {
    return checkInfisicalStatus({ command: parsed.cmd, args: parsed.args, cwd });
  }
  try {
    // Resolve the CLI mise-first so a service tool installed via `mise use -g`
    // (stripe, vercel, supabase, …) is found even when mise isn't activated in
    // the shell; fall back to the bare name for non-mise installs.
    const bin = (await resolveToolBin(parsed.cmd)) ?? parsed.cmd;
    const { stdout, stderr } = await exec(bin, parsed.args, {
      timeout: 15_000,
      cwd,
      env: { ...process.env },
    });
    // Scope the known CLI help contract to Infisical. Arbitrary service output
    // (including empty output or words like "Usage" and "help") remains valid.
    if (infisical && (isInfisicalHelp(stdout) || isInfisicalHelp(stderr))) {
      return {
        ok: false,
        output:
          "Infisical authentication not verified: CLI printed help; use `infisical login status --json --silent`.",
      };
    }
    return { ok: true, output: redactSecrets((stdout || stderr).trim()) };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, output: redactSecrets(message.split("\n")[0]) };
  }
}

export async function checkServices(
  services: Record<string, ServiceConfig>,
  cwd = process.cwd(),
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

    const { ok, output, informational } = await runCheck(config.check, cwd);
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
