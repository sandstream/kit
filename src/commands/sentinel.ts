/**
 * `kit sentinel` command cluster — extracted from cli.ts (5.0-alpha god-module
 * split). cmdSentinel routes `run|install|status` to the module-private handlers
 * below. buildHealthCtx is shared with `kit health` (cmdHealth stays in cli.ts),
 * so it lives in the neutral cli-shared module. Imports only sibling core modules.
 */
import { resolve, dirname } from "node:path";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { c } from "../utils/colors.js";
import { hasFlag, flagValue } from "../utils/flags.js";
import { loadConfig, type kitConfig } from "../config.js";
import { resolveConfigPath, buildHealthCtx } from "../cli-shared.js";
import { isReadOnlyMode } from "../read-only-mode.js";
import { execFileNoThrow } from "../utils/execFileNoThrow.js";
import type { SentinelSummary } from "../sentinel.js";

const SENTINEL_MARKER = /kit-sentinel:([^\s]+?)\s*-->/g;

/** Read-only dedup: open issues and PRs carrying sentinel finding markers. */
async function openSentinelMarkers(): Promise<Set<string> | null> {
  const out = new Set<string>();
  for (const base of [
    ["issue", "list"],
    ["pr", "list"],
  ]) {
    const res = await execFileNoThrow(
      "gh",
      [...base, "--label", "kit-sentinel", "--state", "open", "--json", "body", "--limit", "200"],
      { timeout: 15_000 },
    );
    if (!res.ok) return null; // gh absent/unauth → agent dedups (fail-open)
    try {
      for (const it of JSON.parse(res.stdout) as { body?: string }[]) {
        for (const g of (it.body ?? "").matchAll(SENTINEL_MARKER)) out.add(g[1]);
      }
    } catch {
      return null;
    }
  }
  return out;
}

export async function cmdSentinel(): Promise<boolean> {
  const sub = process.argv[3];
  if (sub === "install") return cmdSentinelInstall();
  if (sub === "status") return cmdSentinelStatus();
  if (sub !== "run") {
    console.error(`${c.red}usage: kit sentinel <run|install|status> [--json]${c.reset}`);
    process.exitCode = 1;
    return false;
  }
  const jsonMode = hasFlag(process.argv, "--json");
  // Config-free: sentinel proposes fixes from codebase analysis; the optional
  // [sentinel] block only adds integrations. Missing .kit.toml is not an error.
  const config = existsSync(resolveConfigPath())
    ? await loadConfig(resolveConfigPath())
    : ({} as kitConfig);
  const { runSentinel, healthToRedFindings, proposalSummary, SENTINEL_CACHE } =
    await import("../sentinel.js");
  const { runHealth, selectSensors, defaultHealthDeps } = await import("../health.js");
  const proposals = await runSentinel(process.cwd(), {
    gatherRed: async () => {
      const ctx = await buildHealthCtx(config);
      return healthToRedFindings(await runHealth(ctx, selectSensors(ctx), defaultHealthDeps));
    },
    openMarkers: openSentinelMarkers,
  });

  // L3: cache a compact summary for the SessionStart surface (#53). Best-effort —
  // a cache-write failure must never fail the run itself.
  //
  // Read-only mode promises "all writes will be refused"; this cache is a write like
  // any other, so it must not persist behind that banner's back (RO-5: it used to,
  // leaving an untracked `.kit/sentinel.json` in an audited read-only repo).
  if (!isReadOnlyMode()) {
    try {
      const cachePath = resolve(process.cwd(), SENTINEL_CACHE);
      await mkdir(dirname(cachePath), { recursive: true });
      writeFileSync(cachePath, JSON.stringify(proposalSummary(proposals), null, 2) + "\n");
    } catch {
      // no cache → status surface simply stays quiet
    }
  }

  if (jsonMode) {
    console.log(JSON.stringify({ proposals }, null, 2));
    return true;
  }

  const fresh = proposals.filter((p) => p.alreadyOpen !== true);
  console.log(
    `${c.bold}kit sentinel${c.reset}  ${c.dim}${proposals.length} proposal(s), ${fresh.length} fresh${c.reset}`,
  );
  if (proposals.length === 0)
    console.log(`  ${c.dim}no red findings — nothing to propose${c.reset}`);
  for (const p of proposals) {
    const tag = p.alreadyOpen === true ? ` ${c.dim}(already open)${c.reset}` : "";
    const color = p.class === "human" ? c.red : p.class === "code" ? c.yellow : c.dim;
    console.log(`  ${color}${p.artifact}${c.reset} ${p.title}${tag}`);
    console.log(`    ${c.dim}${p.findingId} — your agent opens this with its own creds${c.reset}`);
  }
  if (proposals.length > 0)
    console.log(`${c.dim}run with --json and have any agent act on the fresh proposals${c.reset}`);
  return true;
}

/** `kit sentinel install` — scaffold the L3 scheduler (GitHub Actions) (#53). */
async function cmdSentinelInstall(): Promise<boolean> {
  const { sentinelWorkflow } = await import("../sentinel.js");
  const dest = resolve(process.cwd(), ".github/workflows/kit-sentinel.yml");
  const force = hasFlag(process.argv, "--force");
  const schedule = flagValue(process.argv, "--schedule");
  await mkdir(dirname(dest), { recursive: true });
  const body = schedule ? sentinelWorkflow(schedule) : sentinelWorkflow();
  if (force) {
    const stage = mkdtempSync(resolve(dirname(dest), ".kit-sentinel-install-"));
    try {
      const replacement = resolve(stage, "kit-sentinel.yml");
      writeFileSync(replacement, body);
      renameSync(replacement, dest);
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  } else {
    try {
      writeFileSync(dest, body, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      console.error(
        `${c.yellow}.github/workflows/kit-sentinel.yml exists — re-run with --force to overwrite${c.reset}`,
      );
      process.exitCode = 1;
      return false;
    }
  }
  console.log(`${c.green}✓${c.reset} wrote .github/workflows/kit-sentinel.yml`);
  console.log(
    `  ${c.dim}recurs \`kit sentinel run --json\`; an agent (or a downstream step) acts on the JSON${c.reset}`,
  );
  return true;
}

/** `kit sentinel status` — print the cached one-line surface for a SessionStart hook (#53). */
async function cmdSentinelStatus(): Promise<boolean> {
  const { SENTINEL_CACHE, sentinelStatusLine } = await import("../sentinel.js");
  let summary: SentinelSummary | null = null;
  try {
    summary = JSON.parse(readFileSync(resolve(process.cwd(), SENTINEL_CACHE), "utf8"));
  } catch {
    // no cache yet (sentinel never run) → nothing to surface
  }
  if (hasFlag(process.argv, "--json")) {
    console.log(
      JSON.stringify(summary ?? { total: 0, fresh: 0, byClass: { code: 0, human: 0, noise: 0 } }),
    );
    return true;
  }
  const line = sentinelStatusLine(summary);
  if (line) console.log(line); // silent when nothing fresh → clean SessionStart surface
  return true;
}
