// `kit triage gem <name>[@version]`: a RubyGems release, checked before it is installed.
import { c } from "../utils/colors.js";
import { defaultGemDeps, triageGem, type GemTriageDeps } from "../triage-gem.js";

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
