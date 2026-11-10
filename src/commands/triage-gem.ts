// `kit triage gem <name>[@version]`: a RubyGems release, checked before it is installed.
import { join } from "node:path";
import { c } from "../utils/colors.js";
import { defaultCoolingDeps } from "../triage-cooling.js";
import { triageGem, type GemTriageDeps } from "../triage-gem.js";
import { readRegularFileIfPresent } from "../upstream-safe-read.js";

export const defaultGemDeps: GemTriageDeps = {
  ...defaultCoolingDeps,
  lockfile: (cwd) => {
    try {
      return readRegularFileIfPresent(join(cwd, "Gemfile.lock"));
    } catch {
      return null;
    }
  },
};

export async function cmdTriageGem(
  args: string[],
  deps: GemTriageDeps = defaultGemDeps,
): Promise<boolean> {
  const target = args.find((a) => !a.startsWith("--"));
  if (!target) {
    console.error(`${c.red}Usage: kit triage gem <name>[@version]${c.reset}`);
    return false;
  }
  console.log(`${c.bold}Running triage on gem: ${target}${c.reset}\n`);
  const result = await triageGem(process.cwd(), target, deps);
  console.log(result.output);
  if (!result.passed)
    console.log(`\n${c.yellow}⚠️  Review the lines above before installing.${c.reset}`);
  return result.passed;
}
