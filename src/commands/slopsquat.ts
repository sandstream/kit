/**
 * `kit slopsquat <npm|pypi> <name...>` — score packages for hallucination /
 * slopsquat risk from registry metadata (existence + age + release count). Prints
 * a calibrated 0–100 score per package and exits non-zero when any package is at or
 * above the threshold (default: high), so CI can gate on it. Deterministic, zero-LLM.
 */
import { c } from "../utils/colors.js";
import { flagValue } from "../utils/flags.js";
import { assessPackage, type Ecosystem, type SlopLevel, type SlopRisk } from "../slopsquat.js";

const LEVEL_ORDER: Record<SlopLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };

function colorFor(level: SlopLevel): string {
  if (level === "critical" || level === "high") return c.red;
  if (level === "medium") return c.yellow;
  return c.green;
}

export async function cmdSlopsquat(): Promise<boolean> {
  const args = process.argv.slice(3);
  const eco = args[0] as Ecosystem;
  if (eco !== "npm" && eco !== "pypi") {
    console.error(
      `${c.red}usage: kit slopsquat <npm|pypi> <name...> [--fail-on <low|medium|high|critical>]${c.reset}`,
    );
    return false;
  }
  const failOn = (flagValue(process.argv, "--fail-on") ?? "high") as SlopLevel;
  const names = args.slice(1).filter((a) => !a.startsWith("--"));
  // drop the value of --fail-on if it landed in the positional list (space form)
  const failOnValue = flagValue(process.argv, "--fail-on");
  const pkgs = names.filter((n) => n !== failOnValue);
  if (pkgs.length === 0) {
    console.error(`${c.red}usage: kit slopsquat <npm|pypi> <name...>${c.reset}`);
    return false;
  }

  const results: SlopRisk[] = [];
  for (const name of pkgs) {
    results.push(await assessPackage(eco, name));
  }

  let worst = 0;
  for (const r of results) {
    const col = colorFor(r.level);
    console.log(
      `${col}${r.level.toUpperCase().padEnd(8)}${c.reset} ${r.name} ${c.dim}(${r.ecosystem}, score ${r.score})${c.reset}`,
    );
    for (const s of r.signals) console.log(`  ${c.dim}• ${s}${c.reset}`);
    worst = Math.max(worst, LEVEL_ORDER[r.level]);
  }

  const threshold = LEVEL_ORDER[failOn] ?? LEVEL_ORDER.high;
  const passed = worst < threshold;
  if (!passed) {
    console.error(`${c.red}✗ slopsquat: a package is at or above '${failOn}' risk${c.reset}`);
  } else {
    console.log(`${c.green}✓ slopsquat: all packages below '${failOn}' risk${c.reset}`);
  }
  return passed;
}
