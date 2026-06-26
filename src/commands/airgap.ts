// `kit airgap` command — extracted from cli.ts (incremental split).
import { existsSync } from "node:fs";
import { loadConfig, type kitConfig } from "../config.js";
import { c } from "../utils/colors.js";
import { hasFlag } from "../utils/flags.js";
import { resolveConfigPath } from "../cli-shared.js";

export async function cmdAirgap(): Promise<boolean> {
  const sub = process.argv[3];
  const jsonMode = hasFlag(process.argv, "--json");
  if (sub !== "verify") {
    console.error(`${c.red}usage: kit airgap verify${c.reset}`);
    process.exitCode = 1;
    return false;
  }

  const { SCANNERS, airGapScanners, verifyAirGapScanners, semgrepConfig } =
    await import("../scanners.js");
  const { resolveAirGap } = await import("../airgap/config.js");
  const configPath = resolveConfigPath();
  const config = existsSync(configPath) ? await loadConfig(configPath) : ({} as kitConfig);
  const ag = resolveAirGap(config.air_gap, process.env);

  // Evaluate the air-gap plan (what WOULD run with no egress), regardless of
  // whether air-gap is currently enabled — the point is to PROVE the posture.
  const plan = airGapScanners(SCANNERS, true, process.env);
  const cfg = semgrepConfig(process.env);
  const report = verifyAirGapScanners(plan.scanners, { semgrepConfig: cfg });

  if (jsonMode) {
    console.log(
      JSON.stringify(
        { ok: report.ok, enabled: ag.enabled, rows: report.rows, dropped: plan.dropped },
        null,
        2,
      ),
    );
    return report.ok;
  }

  console.log(
    `${c.bold}kit airgap verify${c.reset}  ${c.dim}every runnable scanner must be local (no egress)${c.reset}`,
  );
  if (!ag.enabled) {
    console.log(
      `${c.dim}  air-gap not enabled in .kit.toml / env — verifying what air-gap mode WOULD run${c.reset}`,
    );
  }
  for (const row of report.rows) {
    const mark = row.ok ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`;
    console.log(`  ${mark} ${row.id}  ${c.dim}${row.detail}${c.reset}`);
  }
  for (const id of plan.dropped) {
    console.log(
      `  ${c.dim}− ${id}  dropped (cloud-only / registry — excluded from air-gap)${c.reset}`,
    );
  }
  console.log("");
  if (report.ok) {
    console.log(
      `  ${c.green}air-gap clean: all runnable scanners resolve to local artifacts${c.reset}`,
    );
  } else {
    const bad = report.rows
      .filter((r) => !r.ok)
      .map((r) => r.id)
      .join(", ");
    console.log(`  ${c.red}air-gap NOT provable: ${bad} would egress${c.reset}`);
  }
  return report.ok;
}
