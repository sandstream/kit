/**
 * `kit tools list --auth`: is each CLI logged in, not just installed and current.
 *
 * The probe comes from the project's own `[services.*].check` when it runs the same binary,
 * otherwise from a short built-in table. A tool with no safe, non-interactive probe gets none:
 * `gcloud auth print-access-token` would print a credential and `stripe config --list` proves
 * nothing, so they report "no probe" instead of a guess. Only the status is surfaced, never
 * the probe's output.
 */
import { basename } from "node:path";
import type { ServiceConfig } from "./config.js";
import { parseCommand } from "./utils/parseCommand.js";
import { probeName } from "./tool-inventory.js";

export const BUILTIN_AUTH_PROBES: Readonly<Record<string, string>> = {
  aws: "aws sts get-caller-identity",
  flyctl: "flyctl auth whoami",
  gh: "gh auth status",
  infisical: "infisical login status --json --silent --telemetry=false",
  op: "op whoami",
  supabase: "supabase projects list",
  vercel: "vercel whoami",
  wrangler: "wrangler whoami",
};

export interface AuthProbe {
  command: string;
  via: "service" | "builtin";
}

export interface AuthResult extends AuthProbe {
  status: "authenticated" | "unauthenticated";
}

export type AuthRunner = (command: string) => Promise<{ authenticated: boolean; output: string }>;

function binaryOf(command: string): string | null {
  const parsed = parseCommand(command);
  if (parsed.kind === "informational") return null;
  return basename(parsed.cmd).replace(/\.exe$/i, "");
}

export function authProbeFor(
  tool: string,
  services: Record<string, ServiceConfig>,
): AuthProbe | null {
  const bin = probeName(tool);
  for (const service of Object.values(services)) {
    if (service.check && binaryOf(service.check) === bin)
      return { command: service.check, via: "service" };
  }
  const builtin = BUILTIN_AUTH_PROBES[bin];
  return builtin ? { command: builtin, via: "builtin" } : null;
}

export async function probeAuth(probe: AuthProbe, run: AuthRunner): Promise<AuthResult> {
  const { authenticated } = await run(probe.command);
  return { ...probe, status: authenticated ? "authenticated" : "unauthenticated" };
}
