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

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

export async function cmdTools(): Promise<boolean> {
  const args = process.argv.slice(3);
  const sub = args[0] && !args[0].startsWith("--") ? args[0] : "list";
  if (sub !== "list") {
    console.error(`${c.red}unknown subcommand: kit tools ${sub}${c.reset}`);
    console.error(`${c.dim}available: kit tools list [--latest] [--json]${c.reset}`);
    return false;
  }

  const jsonMode = hasFlag(process.argv, "--json");
  const withCurrency = hasFlag(process.argv, "--latest");

  let declared: Record<string, string> = {};
  try {
    const config = await loadConfig(resolveConfigPath());
    declared = (config.tools ?? {}) as Record<string, string>;
  } catch {
    /* no config here — the undeclared inventory is still worth printing */
  }

  const { inventoryTools } = await import("../tool-inventory.js");
  const facts = await inventoryTools(declared, { withCurrency });

  if (jsonMode) {
    console.log(
      JSON.stringify(
        {
          checkedCurrency: withCurrency,
          tools: facts.map((f) => ({
            name: f.name,
            declared: f.declared ?? null,
            path: f.path,
            source: f.provenance?.source ?? null,
            shimmed: f.provenance?.shimmed ?? null,
            installed: f.installed,
            currency: f.currency ?? null,
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
      `  ${icon} ${pad(f.name, nameW)} ${pad(String(version), 14)} ${c.dim}${pad(source, srcW)}${c.reset} ${shim} ${declaredMark}${note}`,
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
  console.log(`${c.dim}Paths: KIT_TOOLS_PATHS=1${c.reset}`);
  return true;
}
