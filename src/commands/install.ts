/**
 * `kit install` command — extracted from cli.ts (5.0-alpha god-module split).
 * Triage-gated tool install via mise. cmdSetup (still in cli.ts) calls the
 * exported cmdInstall. Imports only sibling core modules.
 */
import { c } from "../utils/colors.js";
import { hasFlag } from "../utils/flags.js";
import { loadConfig } from "../config.js";
import { KIT_FILE, resolveConfigPath } from "../cli-shared.js";
import { consumeElevation } from "../elevation.js";
import { withGovernance } from "../governance-middleware.js";
import { installTools } from "../install.js";

export async function cmdInstall(): Promise<boolean> {
  const config = await loadConfig(resolveConfigPath());

  if (!config.tools || Object.keys(config.tools).length === 0) {
    console.log(`${c.dim}No tools configured in ${KIT_FILE}${c.reset}`);
    return true;
  }

  const toolsConfig = config.tools;

  // WATERTIGHT: kit triages every third-party tool before installing it. The
  // `--no-triage` override is a deliberate, audited security action — it must
  // hold a one-shot elevation, or the install is refused.
  let skipTriage = false;
  if (hasFlag(process.argv, "--no-triage")) {
    const elev = await consumeElevation("tools.install.no-triage");
    if (!elev.ok) {
      console.error(`${c.red}✗ --no-triage refused: ${elev.reason}${c.reset}`);
      console.error(
        `${c.dim}Run 'kit auth elevate --scope tools.install.no-triage' first, or drop --no-triage to let triage run.${c.reset}`,
      );
      return false;
    }
    skipTriage = true;
    console.log(
      `${c.yellow}⚠ --no-triage: triage gate bypassed (elevation consumed, audit-logged)${c.reset}`,
    );
  }

  console.log(`${c.bold}${c.cyan}Installing tools via mise...${c.reset}\n`);

  return await withGovernance(
    config,
    {
      operation: "tools.install",
      operationType: "write",
      metadata: {
        tools: Object.keys(toolsConfig),
        skipTriage,
      },
    },
    async () => {
      const results = await installTools(toolsConfig, undefined, { skipTriage });
      let allOk = true;

      for (const r of results) {
        const icon =
          r.action === "failed"
            ? `${c.red}✗${c.reset}`
            : r.action === "blocked"
              ? `${c.yellow}⛔${c.reset}`
              : `${c.green}✓${c.reset}`;
        const label =
          r.action === "already_ok"
            ? `${c.dim}already installed${c.reset}`
            : r.action === "installed"
              ? `${c.green}installed${c.reset}`
              : r.action === "blocked"
                ? `${c.yellow}blocked by triage${c.reset}`
                : `${c.red}failed${c.reset}`;
        console.log(`  ${icon} ${r.name}  ${label}  ${c.dim}${r.detail}${c.reset}`);
        if (r.action === "failed" || r.action === "blocked") allOk = false;
      }

      console.log();
      return allOk;
    },
  );
}
