/**
 * `kit bootstrap` — one command that cold-starts an ephemeral environment.
 *
 * A thin executor over the pure planner in `../bootstrap.ts`: it reads the seed the
 * platform injected (env vars + flags), plans the ordered steps, spawns each step's
 * kit subcommand, and applies the fail matrix (fail-closed floor aborts; fail-open
 * fuel degrades). It is a COMPOSITION of shipped commands (setup / identity / policy
 * pull / profile import / memory restore) behind one verb + a receipt — no new
 * capability, and no secret is ever fetched, stored, or logged here.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { c } from "../utils/colors.js";
import { hasFlag, flagValue } from "../utils/flags.js";
import {
  planBootstrap,
  classifyStep,
  summarize,
  isFatal,
  type BootstrapSeed,
  type BootstrapOpts,
  type StepResult,
} from "../bootstrap.js";

/** Resolve how to re-invoke this same kit CLI for a subcommand spawn. */
function kitArgv0(): { cmd: string; prefix: string[] } {
  const entry = process.argv[1];
  if (entry) return { cmd: process.execPath, prefix: [resolve(entry)] };
  return { cmd: "kit", prefix: [] }; // last resort — relies on PATH
}

/** Spawn `kit <argv>` inheriting stdio; return true on exit 0. Never throws. */
function runStep(argv: string[]): boolean {
  const { cmd, prefix } = kitArgv0();
  try {
    execFileSync(cmd, [...prefix, ...argv], {
      stdio: "inherit",
      env: { ...process.env, KIT_NON_INTERACTIVE: "1" },
    });
    return true;
  } catch {
    return false;
  }
}

/** Detect the seed from env + flags (no secret values are read into the receipt). */
function readSeed(args: string[]): BootstrapSeed {
  return {
    profileBundle: flagValue(args, "--profile") ?? undefined,
    memoryBackup: process.env.KIT_MEMORY_BACKUP || undefined,
    controlPlane: existsSync(resolve(process.cwd(), ".kit-policy.signers")),
  };
}

export async function cmdBootstrap(): Promise<boolean> {
  // Note: `kit bootstrap --help` is intercepted by the dispatcher (prints the
  // registry help, never runs this handler), so no --help branch is needed here.
  const args = process.argv.slice(3);

  const json = hasFlag(args, "--json");
  const opts: BootstrapOpts = {
    minimal: hasFlag(args, "--minimal"),
    noMemory: hasFlag(args, "--no-memory"),
  };
  const seed = readSeed(args);
  const plan = planBootstrap(seed, opts);

  const results: StepResult[] = [];
  for (const step of plan) {
    if (step.argv === null) {
      results.push(classifyStep(step, null));
      continue;
    }
    if (!json) console.log(`${c.dim}▶ ${step.id}: kit ${step.argv.join(" ")}${c.reset}`);
    const ran = runStep(step.argv);
    const result = classifyStep(step, ran);
    results.push(result);
    if (isFatal(result)) break; // fail-closed step failed — stop the cascade
  }

  const receipt = summarize(results);

  if (json) {
    console.log(JSON.stringify(receipt, null, 2));
  } else {
    console.log(`\n${c.bold}bootstrap receipt${c.reset}`);
    for (const s of receipt.steps) {
      const mark =
        s.status === "ok"
          ? `${c.green}✓${c.reset}`
          : s.status === "skipped"
            ? `${c.dim}−${c.reset}`
            : s.status === "degraded"
              ? `${c.yellow}!${c.reset}`
              : `${c.red}✗${c.reset}`;
      console.log(`  ${mark} ${s.id.padEnd(9)} ${c.dim}${s.detail}${c.reset}`);
    }
    if (receipt.ok && receipt.degraded) {
      console.log(
        `\n${c.yellow}bootstrapped with degraded fuel${c.reset} ${c.dim}(a fail-open step did not complete — environment works, some recall/secrets may be absent)${c.reset}`,
      );
    } else if (receipt.ok) {
      console.log(`\n${c.green}bootstrapped${c.reset}`);
    } else {
      console.log(
        `\n${c.red}bootstrap failed${c.reset} ${c.dim}(a fail-closed floor step failed — see above)${c.reset}`,
      );
    }
  }

  return receipt.ok;
}
