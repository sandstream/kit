/**
 * `kit tools list` — what is actually installed, where it came from, and whether it is current.
 *
 * The inventory nobody had. `[tools]` covered five declared pins; the tools an agent actually
 * decides from (`gh`, `op`, `docker`, `gcloud`, `psql`, …) were not declared, therefore not
 * checked, therefore invisible — and the declared ones were reported without their source or
 * their currency, so `✓ vercel 53.1.1 (need latest)` sat next to a registry that said 59.1.4
 * (#500).
 *
 * Currency lookups are opt-in per run (`--latest`) and cached with a TTL, because putting a
 * registry call per tool on the default path is how a check becomes something people skip.
 * Air-gap reports `unchecked` with the reason, never a version it did not verify.
 */

import { c } from "../utils/colors.js";
import { hasFlag } from "../utils/flags.js";
import { loadConfig } from "../config.js";
import { resolveConfigPath } from "../cli-shared.js";
import type { ServiceConfig } from "../config.js";
import type { AuthResult } from "../tool-auth.js";

function authNote(result: AuthResult | null): string {
  if (!result) return `  ${c.dim}auth: no probe${c.reset}`;
  return result.status === "authenticated"
    ? `  ${c.green}auth: logged in${c.reset}`
    : `  ${c.yellow}auth: not logged in (${result.command})${c.reset}`;
}

/** Probes run in parallel: each is a network round trip, and a slow one must not serialize the rest. */
async function authFor(
  facts: { name: string; path: string | null }[],
  services: Record<string, ServiceConfig>,
): Promise<Map<string, AuthResult | null>> {
  const { authProbeFor, probeAuth } = await import("../tool-auth.js");
  const { checkServices } = await import("../check-services.js");
  const run = async (command: string) => {
    const [status] = await checkServices({ probe: { login: "", check: command } });
    return { authenticated: status.authenticated, output: status.output };
  };
  const entries = await Promise.all(
    facts.map(async (f): Promise<[string, AuthResult | null]> => {
      const probe = f.path ? authProbeFor(f.name, services) : null;
      return [f.name, probe ? await probeAuth(probe, run) : null];
    }),
  );
  return new Map(entries);
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

export async function cmdTools(): Promise<boolean> {
  const args = process.argv.slice(3);
  const sub = args[0] && !args[0].startsWith("--") ? args[0] : "list";
  if (sub !== "list") {
    console.error(`${c.red}unknown subcommand: kit tools ${sub}${c.reset}`);
    console.error(`${c.dim}available: kit tools list [--latest] [--auth] [--json]${c.reset}`);
    return false;
  }

  const jsonMode = hasFlag(process.argv, "--json");
  const withCurrency = hasFlag(process.argv, "--latest");

  const withAuth = hasFlag(process.argv, "--auth");

  let declared: Record<string, string> = {};
  let services: Record<string, ServiceConfig> = {};
  try {
    const config = await loadConfig(resolveConfigPath());
    declared = (config.tools ?? {}) as Record<string, string>;
    services = config.services ?? {};
  } catch {
    /* no config here — the undeclared inventory is still worth printing */
  }

  const { inventoryTools } = await import("../tool-inventory.js");
  const facts = await inventoryTools(declared, { withCurrency });
  const auth = withAuth ? await authFor(facts, services) : new Map<string, AuthResult | null>();

  if (jsonMode) {
    console.log(
      JSON.stringify(
        {
          checkedCurrency: withCurrency,
          checkedAuth: withAuth,
          tools: facts.map((f) => ({
            name: f.name,
            declared: f.declared ?? null,
            path: f.path,
            source: f.provenance?.source ?? null,
            shimmed: f.provenance?.shimmed ?? null,
            installed: f.installed,
            currency: f.currency ?? null,
            ...(withAuth ? { auth: auth.get(f.name) ?? null } : {}),
          })),
        },
        null,
        2,
      ),
    );
    return true;
  }

  console.log(`${c.bold}${c.cyan}kit tools list${c.reset}`);
  console.log(`${c.dim}${"─".repeat(64)}${c.reset}`);
  const nameW = Math.max(10, ...facts.map((f) => f.name.length)) + 2;
  const srcW = 10;

  for (const f of facts) {
    const declaredMark = f.declared ? `${c.dim}(pin ${f.declared})${c.reset}` : "";
    if (!f.path) {
      console.log(
        `  ${c.red}✗${c.reset} ${pad(f.name, nameW)} ${c.red}not installed${c.reset}  ${declaredMark}`,
      );
      continue;
    }
    const source = f.provenance?.source ?? "unknown";
    const shim = f.provenance?.shimmed ? `${c.dim}(shim)${c.reset}` : "";
    const version = f.installed ?? `${c.yellow}version unreadable${c.reset}`;
    const drift = f.currency;
    const icon =
      drift?.drift === "behind"
        ? `${c.yellow}!${c.reset}`
        : drift?.drift === "unknown"
          ? `${c.dim}−${c.reset}`
          : `${c.green}✓${c.reset}`;
    const note =
      drift?.drift === "behind"
        ? `  ${c.yellow}→ ${drift.latest} available${c.reset}`
        : drift?.drift === "ahead"
          ? `  ${c.dim}ahead of ${drift.latest}${c.reset}`
          : drift?.drift === "unknown"
            ? `  ${c.dim}unchecked: ${drift.reason}${c.reset}`
            : "";
    console.log(
      `  ${icon} ${pad(f.name, nameW)} ${pad(String(version), 14)} ${c.dim}${pad(source, srcW)}${c.reset} ${shim} ${declaredMark}${note}${withAuth ? authNote(auth.get(f.name) ?? null) : ""}`,
    );
    if (f.path && process.env.KIT_TOOLS_PATHS === "1") {
      console.log(`      ${c.dim}${f.path}${c.reset}`);
    }
  }

  console.log();
  const declaredCount = facts.filter((f) => f.declared).length;
  console.log(
    `${c.dim}${facts.length} tool(s): ${declaredCount} declared in .kit.toml, ${facts.length - declaredCount} found on PATH.${c.reset}`,
  );
  if (!withCurrency) {
    console.log(
      `${c.dim}Currency not checked — pass ${c.bold}--latest${c.reset}${c.dim} to compare against each installer's newest version (cached ${process.env.KIT_TOOL_LATEST_TTL_H ?? 24}h).${c.reset}`,
    );
  }
  if (!withAuth) {
    console.log(
      `${c.dim}Login not checked — pass ${c.bold}--auth${c.reset}${c.dim} to run each CLI's non-interactive login probe.${c.reset}`,
    );
  }
  console.log(`${c.dim}Paths: KIT_TOOLS_PATHS=1${c.reset}`);
  return true;
}
