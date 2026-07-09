/**
 * `kit review` — meta-runner: check + design + standards in one shot.
 * Convenient single-command gate for AI agents and PR checks. Extracted from
 * cli.ts (5.0-alpha god-module split); orchestrates the now-extracted check,
 * design, and standards clusters, so it moves out only after they do.
 */
import { c } from "../utils/colors.js";
import { hasFlag } from "../utils/flags.js";
import { cmdCheck } from "./check.js";
import { cmdDesign } from "./design.js";
import { cmdStandards } from "./standards.js";

export async function cmdReview(): Promise<boolean> {
  const jsonMode = hasFlag(process.argv, "--json");
  let allOk = true;
  if (!jsonMode) console.log(`${c.bold}kit review${c.reset} — full repo audit\n`);

  if (!jsonMode) console.log(`${c.bold}=== check ===${c.reset}`);
  const checkOk = await cmdCheck();
  if (!checkOk) allOk = false;

  if (!jsonMode) console.log(`\n${c.bold}=== design ===${c.reset}`);
  const designOk = await cmdDesign();
  if (!designOk) allOk = false;

  if (!jsonMode) console.log(`\n${c.bold}=== standards ===${c.reset}`);
  const standardsOk = await cmdStandards();
  if (!standardsOk) allOk = false;

  if (!jsonMode) {
    console.log(
      `\n${c.bold}${allOk ? `${c.green}✓ review passed` : `${c.red}✗ review failed`}${c.reset}`,
    );
  }
  return allOk;
}
