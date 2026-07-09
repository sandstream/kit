/**
 * `kit standards` + `kit baseline` commands — extracted from cli.ts (5.0-alpha
 * god-module split). freezeStandardsBaseline is shared by `standards freeze` and
 * `baseline freeze` (both here), so it stays module-private. cmdReview stays in
 * cli.ts (it orchestrates cmdCheck + cmdDesign, still inline). Imports only
 * sibling core modules.
 */
import { c } from "../utils/colors.js";
import { hasFlag, flagValue } from "../utils/flags.js";
import { loadConfig } from "../config.js";
import { resolveConfigPath } from "../cli-shared.js";
import type { Baseline } from "../baseline.js";

/**
 * `kit standards` — the deterministic dev-standards gate (P1: the general,
 * language-agnostic code-quality metrics via lizard/jscpd/scc). Mirrors `kit design`:
 * warn by default, `--enforce` fails on net-new findings AND on setup gaps (a tool
 * that could not run) — fail-closed for CI, quiet for local first-runs.
 */
/**
 * Snapshot every `kit standards` dimension (general + specific + plugins + platform)
 * into the given baseline object and return the total number of findings frozen.
 * Shared by `kit baseline freeze` and `kit standards freeze` so the two never drift.
 */
async function freezeStandardsBaseline(baseline: Baseline, cwd: string): Promise<number> {
  const { collectStandardsKeys } = await import("../check-standards.js");
  const { collectSpecificKeys, SPECIFIC_LANGUAGES } =
    await import("../check-standards-specific.js");
  const { collectPluginKeys, DEFAULT_PLUGIN_DIR } = await import("../standards-plugins.js");
  const { collectMjsPluginKeys } = await import("../standards-plugins-exec.js");
  const { collectPlatformKeys } = await import("../check-standards-platform.js");
  const { detectStack } = await import("../stack-detector.js");
  const { baselineSet } = await import("../baseline.js");
  const cfg = await loadConfig(resolveConfigPath()).catch(
    () => ({}) as Awaited<ReturnType<typeof loadConfig>>,
  );

  const general = await collectStandardsKeys(cwd);
  baselineSet(baseline, "standards", "complexity", general.complexity);
  baselineSet(baseline, "standards", "duplication", general.duplication);
  baselineSet(baseline, "standards", "size", general.size);

  const lang = (await detectStack(cwd)).language;
  let specificCount = 0;
  if (SPECIFIC_LANGUAGES.includes(lang)) {
    const keys = await collectSpecificKeys(cwd, lang);
    baselineSet(baseline, "standards", `specific/${lang}`, keys);
    specificCount = keys.length;
  }

  const dirs =
    cfg.standards?.plugins?.dirs && cfg.standards.plugins.dirs.length > 0
      ? cfg.standards.plugins.dirs
      : [DEFAULT_PLUGIN_DIR];
  const pluginKeys = [
    ...collectPluginKeys(cwd, lang, dirs),
    ...(await collectMjsPluginKeys(cwd, lang, dirs)),
  ];
  baselineSet(baseline, "standards", "plugins", pluginKeys);

  const platformKeys = await collectPlatformKeys(cwd);
  baselineSet(baseline, "standards", "platform", platformKeys);

  return (
    general.complexity.length +
    general.duplication.length +
    general.size.length +
    specificCount +
    pluginKeys.length +
    platformKeys.length
  );
}

/** `kit standards freeze` — snapshot ONLY the standards dimensions into the baseline. */
async function cmdStandardsFreeze(): Promise<boolean> {
  const { loadBaseline, saveBaseline, BASELINE_FILE } = await import("../baseline.js");
  const baseline = await loadBaseline();
  const total = await freezeStandardsBaseline(baseline, process.cwd());
  await saveBaseline(baseline);
  console.log(
    `${c.green}✓${c.reset} Wrote ${BASELINE_FILE} — ${total} standards finding(s) frozen (general + specific + plugins + platform).`,
  );
  console.log(`  Future \`kit standards\` runs gate only on NEW findings.`);
  return true;
}

export async function cmdStandards(): Promise<boolean> {
  const sub = process.argv[3];
  if (sub === "freeze") return cmdStandardsFreeze();
  const enforce = hasFlag(process.argv, "--enforce");
  const jsonMode = hasFlag(process.argv, "--json");
  const category = flagValue(process.argv, "--category"); // general | specific | plugins | platform | <lang>
  const { BASELINE_FILE } = await import("../baseline.js");
  const { runStandardsGate } = await import("../standards-run.js");
  // The SAME orchestration the MCP `kit_standards` tool uses — no divergent gate.
  const {
    ok,
    checks: results,
    summary,
    baselineIgnored,
  } = await runStandardsGate({
    enforce,
    category,
  });
  if (baselineIgnored) {
    console.error(
      `${c.yellow}!${c.reset} ${BASELINE_FILE} ignored (${baselineIgnored}) — gating on all findings`,
    );
  }
  const gaps = results.filter((r) => r.didNotRun);
  if (jsonMode) {
    console.log(JSON.stringify({ ok, checks: results, summary }, null, 2));
    return ok;
  }
  console.log(
    `${c.bold}Standards${c.reset} ${c.dim}(general + per-language + plugins + platform — deterministic, zero-LLM)${c.reset}`,
  );
  for (const r of results) {
    const icon =
      r.status === "pass"
        ? `${c.green}✓${c.reset}`
        : r.status === "fail"
          ? `${c.red}✗${c.reset}`
          : r.status === "warn"
            ? `${c.yellow}!${c.reset}`
            : `${c.dim}-${c.reset}`;
    console.log(`  ${icon} ${r.name}  ${c.dim}${r.detail}${c.reset}`);
    if (r.files) for (const f of r.files) console.log(`      ${c.dim}- ${f}${c.reset}`);
  }
  // Score over gates that ran, then setup gaps and findings called out separately so
  // neither is mistaken for the other.
  const scoreColor = summary.failed > 0 ? c.red : summary.findings > 0 ? c.yellow : c.green;
  console.log(
    `  ${scoreColor}score ${summary.score}${c.reset} gates passed` +
      `${summary.findings > 0 ? ` · ${summary.findings} with findings` : ""}` +
      `${gaps.length > 0 ? ` · ${c.dim}${gaps.length} setup gap(s) (not run)${c.reset}` : ""}`,
  );
  if (gaps.length > 0 && !enforce) {
    console.log(
      `  ${c.dim}setup gaps are un-provisioned tools, not failures — install them to enable those gates; --enforce fails CI on them${c.reset}`,
    );
  }
  return ok;
}
/**
 * `kit baseline freeze` — snapshot current warnings into .kit-baseline.json
 * so future runs only gate on net-new findings. Currently freezes:
 *   - tests.untested_files
 */
export async function cmdBaseline(): Promise<boolean> {
  const sub = process.argv[3];
  if (!sub || sub === "--help" || sub === "-h") {
    console.log(`${c.bold}kit baseline${c.reset} — freeze current warnings`);
    console.log("\nUsage:");
    console.log("  kit baseline freeze   Snapshot current findings as the new baseline");
    console.log("  kit baseline show     Print contents of .kit-baseline.json");
    return true;
  }

  const { loadBaseline, saveBaseline, baselineSet, BASELINE_FILE } = await import("../baseline.js");
  const baseline = await loadBaseline();

  if (sub === "show") {
    console.log(JSON.stringify(baseline, null, 2));
    return true;
  }

  if (sub !== "freeze") {
    console.error(`${c.red}Unknown subcommand: ${sub}${c.reset}`);
    return false;
  }

  const { findUntestedSources } = await import("../check-tests.js");
  const { collectDesignKeys } = await import("../check-design.js");
  const untested = await findUntestedSources();
  baselineSet(baseline, "tests", "untested_files", untested);
  const design = await collectDesignKeys();
  baselineSet(baseline, "design", "a11y", design.a11y);
  baselineSet(baseline, "design", "tokens", design.tokens);
  // All standards dimensions (general + specific + plugins + platform) via the shared helper.
  const standardsTotal = await freezeStandardsBaseline(baseline, process.cwd());
  await saveBaseline(baseline);
  console.log(
    `${c.green}✓${c.reset} Wrote ${BASELINE_FILE} — ${untested.length} untested file(s), ${design.a11y.length} a11y, ${design.tokens.length} design-token, ${standardsTotal} standards finding(s) frozen.`,
  );
  console.log(`  Future runs will gate only on NEW findings.`);
  return true;
}
