/**
 * Read-only status/inspection commands, extracted from cli.ts (5.0-alpha
 * god-module split). `kit status`, `health`, `ingest`, `supply-chain`,
 * `agent-audit`, `whoami`, `version` — all independent leaves (no cross-cluster
 * cmd* calls), each returning a boolean verdict for the COMMANDS dispatch table.
 */
import { existsSync } from "node:fs";
import { c } from "../utils/colors.js";
import { hasFlag, flagValue } from "../utils/flags.js";
import { loadConfig, type kitConfig } from "../config.js";
import { resolveConfigPath, buildHealthCtx } from "../cli-shared.js";
import { resolveMode, modeScore } from "../setup-modes.js";
import { quickSubsystems } from "../statusline.js";
import { gatherStatus } from "../status.js";
import { withGovernance } from "../governance-middleware.js";
import { KIT_VERSION } from "../cli-checks-shared.js";

export async function cmdStatus(): Promise<boolean> {
  const items = await gatherStatus();
  if (hasFlag(process.argv, "--json")) {
    console.log(JSON.stringify(items, null, 2));
    return true;
  }
  const done = items.filter((i) => i.ok).length;
  console.log(`${c.bold}kit status${c.reset}  ${c.dim}${done}/${items.length} set up${c.reset}`);
  // Mode-aware score: how many of the active mode's expected subsystems are in place.
  let cfgMode: string | undefined;
  try {
    cfgMode = (await loadConfig(resolveConfigPath())).setup?.mode;
  } catch {
    /* no/invalid .kit.toml */
  }
  const { profile } = resolveMode(flagValue(process.argv, "--mode"), cfgMode);
  const ms = modeScore(profile, quickSubsystems(process.cwd()));
  const nextGaps = ms.gaps
    .map((g) => g.next)
    .filter(Boolean)
    .slice(0, 3)
    .join(", ");
  console.log(
    `${c.dim}mode ${c.reset}${c.bold}${profile.mode}${c.reset}${c.dim}: ${ms.done}/${ms.total} subsystems${ms.gaps.length ? ` — next: ${nextGaps}` : " ✓"}${c.reset}\n`,
  );
  for (const item of items) {
    const mark = item.ok ? `${c.green}✓${c.reset}` : `${c.yellow}○${c.reset}`;
    const hint = !item.ok && item.hint ? `  ${c.dim}→ ${item.hint}${c.reset}` : "";
    console.log(`  ${mark} ${item.label}  ${c.dim}${item.detail}${c.reset}${hint}`);
  }
  return true;
}

export async function cmdHealth(): Promise<boolean> {
  const jsonMode = hasFlag(process.argv, "--json");
  const config = await loadConfig(resolveConfigPath());

  return await withGovernance(
    config,
    { operation: "health", operationType: "read", metadata: {} },
    async () => {
      const { runHealth, selectSensors, defaultHealthDeps, formatHealth, healthOk } =
        await import("../health.js");
      const { syncHealthFindings } = await import("../health-track.js");

      const ctx = await buildHealthCtx(config);

      const sensors = selectSensors(ctx);
      const findings = await runHealth(ctx, sensors, defaultHealthDeps);
      await syncHealthFindings(findings); // mirror red into PAL (fail-open)

      if (jsonMode) {
        const ok = healthOk(findings);
        console.log(JSON.stringify({ ok, findings }, null, 2));
        return ok;
      }

      const { lines, redCount, nonGreenCount } = formatHealth(findings);
      console.log(`${c.bold}kit health${c.reset}  ${c.dim}${sensors.length} sensor(s)${c.reset}`);
      if (findings.length === 0) {
        console.log(`  ${c.dim}no connected external systems detected${c.reset}`);
      }
      for (const line of lines) {
        const color = line.startsWith("✗") ? c.red : line.startsWith("?") ? c.yellow : c.green;
        console.log(`  ${color}${line}${c.reset}`);
      }
      if (nonGreenCount > 0) {
        console.log(`${c.red}${nonGreenCount} not green (${redCount} red)${c.reset}`);
      }
      return nonGreenCount === 0;
    },
  );
}

export { cmdIngest } from "./ingest.js";

export async function cmdSupplyChain(): Promise<boolean> {
  const jsonMode = hasFlag(process.argv, "--json");
  // Config-free: supply-chain triage is project-agnostic (it reads the lockfile,
  // not .kit.toml), so a missing config is not an error — mirror `kit scan`.
  const config = existsSync(resolveConfigPath())
    ? await loadConfig(resolveConfigPath())
    : ({} as kitConfig);
  const scopes = config.supply_chain?.internal_scopes ?? [];
  const { runSupplyChain } = await import("../supply-chain.js");
  const results = runSupplyChain(process.cwd(), scopes);
  const fails = results.filter((r) => r.status === "fail").length;

  if (jsonMode) {
    console.log(JSON.stringify({ ok: fails === 0, results }, null, 2));
    return fails === 0;
  }

  console.log(`${c.bold}kit supply-chain${c.reset}`);
  for (const r of results) {
    const mark =
      r.status === "fail"
        ? `${c.red}✗${c.reset}`
        : r.status === "warn"
          ? `${c.yellow}!${c.reset}`
          : r.status === "skip"
            ? `${c.dim}−${c.reset}`
            : `${c.green}✓${c.reset}`;
    console.log(`  ${mark} ${r.name}  ${c.dim}${r.detail}${c.reset}`);
    if (r.suggestion) console.log(`      ${c.dim}${r.suggestion}${c.reset}`);
  }
  if (fails > 0) console.log(`${c.red}${fails} fail${c.reset}`);
  return fails === 0;
}

export async function cmdAgentAudit(): Promise<boolean> {
  const jsonMode = hasFlag(process.argv, "--json");
  const { runAgentAudit } = await import("../agent-audit.js");
  const { runAgentTrifecta } = await import("../agent-trifecta.js");
  const { runAgentPreload } = await import("../agent-preload.js");
  const { homedir } = await import("node:os");
  const results = [
    ...runAgentAudit(process.cwd()),
    ...runAgentTrifecta(process.cwd(), homedir()),
    ...runAgentPreload(process.cwd(), homedir(), process.env),
  ];
  const fails = results.filter((r) => r.status === "fail").length;

  if (jsonMode) {
    console.log(JSON.stringify({ ok: fails === 0, results }, null, 2));
    return fails === 0;
  }

  console.log(
    `${c.bold}kit agent-audit${c.reset}  ${c.dim}agent/MCP configs + hooks + risky grants and writes${c.reset}`,
  );
  for (const r of results) {
    const mark =
      r.status === "fail"
        ? `${c.red}✗${c.reset}`
        : r.status === "warn"
          ? `${c.yellow}!${c.reset}`
          : `${c.green}✓${c.reset}`;
    console.log(`  ${mark} ${r.name}  ${c.dim}${r.detail}${c.reset}`);
    if (r.suggestion) console.log(`      ${c.dim}${r.suggestion}${c.reset}`);
  }
  if (fails > 0) console.log(`${c.red}${fails} fail${c.reset}`);
  return fails === 0;
}

export { cmdWhoami } from "./whoami.js";

export function cmdVersion(): boolean {
  console.log(KIT_VERSION);
  return true;
}
