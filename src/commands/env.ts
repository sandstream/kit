// `kit env` commands — extracted from cli.ts (split step 2).
import { loadConfig, resolveActiveEnvironment, type kitConfig } from "../config.js";
import { KNOWN_ENVS, writeActiveEnv, readActiveEnv, type kitEnv } from "../env-switch.js";
import { promptConfirm } from "../utils/prompt.js";
import { inspectEnv } from "../env-inspect.js";
import { isNonInteractive } from "../environment.js";
import { c } from "../utils/colors.js";
import { hasFlag } from "../utils/flags.js";
import { resolveConfigPath } from "../cli-shared.js";

async function cmdEnvList(): Promise<boolean> {
  let config: kitConfig;
  try {
    // Load base config without env merge so we can inspect [env.*] sections
    config = await loadConfig(resolveConfigPath(), "dev");
  } catch {
    console.log(`${c.dim}No .kit.toml found — no environments configured.${c.reset}`);
    return true;
  }

  const activeEnv = resolveActiveEnvironment();
  const envSections = config.env ?? {};
  const envNames = ["dev", ...Object.keys(envSections).filter((k) => k !== "dev")];

  console.log(`${c.bold}${c.cyan}Environments${c.reset}  ${c.dim}(active: ${activeEnv})${c.reset}\n`);

  for (const name of envNames) {
    const isActive = name === activeEnv;
    const marker = isActive ? `${c.green}●${c.reset} ` : "  ";
    const override = envSections[name];

    if (!override) {
      console.log(`  ${marker}${c.bold}${name}${c.reset}  ${c.dim}base config (default)${c.reset}`);
      continue;
    }

    // Summarise which keys are overridden
    const overrideKeys: string[] = [];
    if (override.tools) overrideKeys.push(`tools(${Object.keys(override.tools).join(",")})`);
    if (override.secrets) overrideKeys.push(`secrets.store=${override.secrets.store ?? "?"}`);
    if (override.services) overrideKeys.push(`services(${Object.keys(override.services).join(",")})`);
    if (override.governance) overrideKeys.push("governance");
    if (override.skills) overrideKeys.push("skills");

    const summary = overrideKeys.length > 0 ? overrideKeys.join(", ") : "no overrides";
    console.log(`  ${marker}${c.bold}${name}${c.reset}  ${c.dim}${summary}${c.reset}`);
  }

  if (Object.keys(envSections).length === 0) {
    console.log(`${c.dim}\nNo [env.*] sections defined in .kit.toml.${c.reset}`);
    console.log(`${c.dim}Add [env.staging.*] or [env.production.*] to configure per-environment overrides.${c.reset}`);
  }

  console.log();
  return true;
}

async function cmdEnvSwitch(): Promise<boolean> {
  // argv layout: [node, cli.js, "env", "switch", "<target>"]
  const target = process.argv[4];
  if (!target || !KNOWN_ENVS.includes(target as kitEnv)) {
    console.error(
      `${c.red}Usage: kit env switch <${KNOWN_ENVS.join("|")}>${c.reset}`,
    );
    return false;
  }
  const env = target as kitEnv;

  console.log(`${c.bold}${c.cyan}kit env switch ${env}${c.reset}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);

  if (env === "prod" && !isNonInteractive()) {
    console.log(
      `${c.red}⚠ Switching to ${c.bold}prod${c.reset}${c.red} unlocks production credentials in this shell.${c.reset}`,
    );
    console.log(
      `${c.dim}Anything that reads ${c.bold}.env.local${c.reset}${c.dim} after this point can call live services.${c.reset}\n`,
    );
    const ok = await promptConfirm(
      `Continue? [y/N] (auto-no in 10s): `,
      10_000,
      false, // fail closed: prompt promises auto-no
    );
    if (!ok) {
      console.log(`${c.dim}Aborted — active env unchanged.${c.reset}`);
      return false;
    }
  }

  const state = await writeActiveEnv(env, process.cwd());
  console.log(
    `  ${c.green}✓${c.reset} active env is now ${c.bold}${state.env}${c.reset}  ${c.dim}(by ${state.switchedBy} at ${state.switchedAt})${c.reset}`,
  );

  if (env === "prod") {
    console.log(
      `\n${c.dim}Re-run ${c.bold}kit secrets${c.reset}${c.dim} to materialize prod values into .env.local. ${c.bold}kit env switch dev${c.reset}${c.dim} when done.${c.reset}\n`,
    );
  } else {
    console.log(
      `\n${c.dim}Prod-scoped keys are now refused unless you switch back or set ${c.bold}KIT_PROD_OK=1${c.reset}${c.dim}.${c.reset}\n`,
    );
  }
  return true;
}

async function cmdEnvCurrent(): Promise<boolean> {
  const state = await readActiveEnv(process.cwd());
  if (!state) {
    console.log(
      `${c.dim}No active env set (defaulting to ${c.bold}dev${c.reset}${c.dim}). Run ${c.bold}kit env switch <env>${c.reset}${c.dim} to set one.${c.reset}`,
    );
    console.log(`dev`);
    return true;
  }
  const color =
    state.env === "prod" ? c.red : state.env === "staging" ? c.yellow : c.green;
  console.log(
    `${color}${state.env}${c.reset}  ${c.dim}(set ${state.switchedAt} by ${state.switchedBy})${c.reset}`,
  );
  return true;
}

export async function cmdEnv(): Promise<boolean> {
  const args = process.argv.slice(2); // includes "env"
  // Route subcommand: kit env list / switch / current / validate
  if (args[1] === "list") return cmdEnvList();
  if (args[1] === "switch") return cmdEnvSwitch();
  if (args[1] === "current") return cmdEnvCurrent();

  const showValues = hasFlag(args, "--show-values");
  const missingOnly = hasFlag(args, "--missing");
  const jsonMode = hasFlag(args, "--json");

  let config: ReturnType<typeof Object.create> = {};
  try {
    config = await loadConfig(resolveConfigPath());
  } catch {
    // Works without .kit.toml — shows .env.local contents only
  }

  const result = await inspectEnv(config, { showValues, missingOnly, cwd: process.cwd() });

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    return result.ok;
  }

  console.log(`${c.bold}${c.cyan}Environment${c.reset}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);

  if (!result.envLocalExists) {
    console.log(
      `${c.yellow}⚠${c.reset}  .env.local not found — run ${c.bold}kit secrets${c.reset} to generate it\n`
    );
  }

  if (result.keys.length === 0) {
    if (missingOnly) {
      console.log(`${c.green}✓${c.reset}  All keys are set\n`);
    } else {
      console.log(`${c.dim}No keys configured or found${c.reset}\n`);
    }
    return result.ok;
  }

  for (const key of result.keys) {
    const icon = key.set ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`;
    const valueStr = key.set
      ? showValues
        ? `${c.dim}${key.value}${c.reset}`
        : `${c.dim}${key.redacted}${c.reset}`
      : `${c.red}not set${c.reset}`;
    const src = `${c.dim}[${key.source}]${c.reset}`;
    console.log(`  ${icon} ${key.name}  ${valueStr}  ${src}`);
  }

  console.log();

  if (!result.ok && !missingOnly) {
    console.log(
      `${c.dim}Run ${c.reset}${c.bold}kit env --missing${c.reset}${c.dim} to see only unset keys${c.reset}`
    );
    console.log(
      `${c.dim}Run ${c.reset}${c.bold}kit secrets${c.reset}${c.dim} to generate .env.local${c.reset}\n`
    );
  }

  return result.ok;
}
