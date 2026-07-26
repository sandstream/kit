/**
 * `kit design` command — extracted from cli.ts (5.0-alpha god-module split).
 * Self-contained (a11y + design-token consistency, baseline-aware). runDesignGate
 * is the structured core; cmdDesign renders it, and `kit review`'s design stage
 * (collectReview) consumes it directly — same parity discipline as standards-run.
 */
import { c } from "../utils/colors.js";
import { hasFlag } from "../utils/flags.js";
import type { DesignCheckResult } from "../check-design.js";

export interface DesignRunResult {
  ok: boolean;
  checks: DesignCheckResult[];
  baselineIgnored: string | null;
}

/** The design gate core: baseline-aware a11y + design-token checks, no printing. */
export async function runDesignGate(
  opts: { cwd?: string; enforce?: boolean } = {},
): Promise<DesignRunResult> {
  const { checkDesign } = await import("../check-design.js");
  const { loadBaselineForGate, baselineGet } = await import("../baseline.js");
  const { baseline, ignored } = await loadBaselineForGate(opts.cwd);
  const checks = await checkDesign({
    enforce: opts.enforce,
    baseline: {
      a11y: baselineGet(baseline, "design", "a11y"),
      tokens: baselineGet(baseline, "design", "tokens"),
    },
  });
  return { ok: checks.every((r) => r.status !== "fail"), checks, baselineIgnored: ignored };
}

/**
 * `kit design` — a11y + design-token consistency, baseline-aware.
 */
export async function cmdDesign(): Promise<boolean> {
  const enforce = hasFlag(process.argv, "--enforce");
  const jsonMode = hasFlag(process.argv, "--json");
  const { ok, checks: results, baselineIgnored } = await runDesignGate({ enforce });
  if (baselineIgnored) {
    const { BASELINE_FILE } = await import("../baseline.js");
    console.error(
      `${c.yellow}!${c.reset} ${BASELINE_FILE} ignored (${baselineIgnored}) — gating on all findings`,
    );
  }
  if (jsonMode) {
    console.log(JSON.stringify({ ok, checks: results }, null, 2));
    return ok;
  }
  console.log(`${c.bold}Design${c.reset}`);
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
  return ok;
}
