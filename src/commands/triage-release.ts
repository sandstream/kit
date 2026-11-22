// `kit triage cargo <crate>[@version]` and `kit triage go <package>[@version]`: a registry
// release, checked before `cargo install` / `go install` builds and installs it.
import { c } from "../utils/colors.js";
import type { ReleaseTriageResult } from "../triage-registry.js";

type Triage = (cwd: string, target: string) => Promise<ReleaseTriageResult>;

async function run(kind: string, usage: string, args: string[], triage: Triage): Promise<boolean> {
  const target = args.find((a) => !a.startsWith("--"));
  if (!target) {
    console.error(`${c.red}Usage: kit triage ${usage}${c.reset}`);
    return false;
  }
  console.log(`${c.bold}Running triage on ${kind}: ${target}${c.reset}\n`);
  const result = await triage(process.cwd(), target);
  console.log(result.output);
  if (!result.passed)
    console.log(`\n${c.yellow}⚠️  Review the lines above before installing.${c.reset}`);
  return result.passed;
}

export async function cmdTriageCargo(args: string[], triage?: Triage): Promise<boolean> {
  const live: Triage = async (cwd, target) =>
    (await import("../triage-cargo.js")).triageCargo(cwd, target);
  return run("crate", "cargo <crate>[@version]", args, triage ?? live);
}

export async function cmdTriageGo(args: string[], triage?: Triage): Promise<boolean> {
  const live: Triage = async (cwd, target) =>
    (await import("../triage-go.js")).triageGo(cwd, target);
  return run("Go module", "go <package>[@version]", args, triage ?? live);
}
