/**
 * `kit design` command — extracted from cli.ts (5.0-alpha god-module split).
 * Self-contained (a11y + design-token consistency, baseline-aware). cmdReview
 * (still in cli.ts) calls the exported cmdDesign. Imports only sibling core modules.
 */
import { c } from "../utils/colors.js";
import { hasFlag } from "../utils/flags.js";

/**
 * `kit design` — a11y + design-token consistency, baseline-aware.
 */
export async function cmdDesign(): Promise<boolean> {
  const enforce = hasFlag(process.argv, "--enforce");
  const jsonMode = hasFlag(process.argv, "--json");
  const { checkDesign } = await import("../check-design.js");
  const { loadBaselineForGate, baselineGet, BASELINE_FILE } = await import("../baseline.js");
  const { baseline, ignored: baselineIgnored } = await loadBaselineForGate();
  if (baselineIgnored) {
    console.error(
      `${c.yellow}!${c.reset} ${BASELINE_FILE} ignored (${baselineIgnored}) — gating on all findings`,
    );
  }
  const results = await checkDesign({
    enforce,
    baseline: {
      a11y: baselineGet(baseline, "design", "a11y"),
      tokens: baselineGet(baseline, "design", "tokens"),
    },
  });
  if (jsonMode) {
    console.log(
      JSON.stringify({ ok: results.every((r) => r.status !== "fail"), checks: results }, null, 2),
    );
    return results.every((r) => r.status !== "fail");
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
  return results.every((r) => r.status !== "fail");
}
