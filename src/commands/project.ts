/**
 * Project-lifecycle commands, extracted from cli.ts (5.0-alpha god-module
 * split). `kit create-plugin`, `clone`, `run`, `open` — each an independent
 * leaf returning a boolean verdict for the COMMANDS dispatch table. `cmdClone`
 * runs `cmdSetup` in the cloned repo, imported from the sibling setup module
 * (no cycle: setup does not import project).
 */
import { resolve } from "node:path";
import { c } from "../utils/colors.js";
import { hasFlag, flagValue } from "../utils/flags.js";
import { createPlugin } from "../create-plugin.js";
import { cloneRepository } from "../clone.js";
import { executeCommand } from "../run.js";
import { listServices, openService } from "../open.js";
import { cmdSetup } from "./setup.js";

export async function cmdCreatePlugin(): Promise<boolean> {
  const pluginName = process.argv[3];

  if (!pluginName) {
    console.error(`${c.red}Usage: kit create-plugin <name>${c.reset}`);
    console.error(`${c.dim}Example: kit create-plugin aws-s3${c.reset}`);
    console.error(
      `${c.dim}Creates ./kit-plugin-aws-s3/ with a working TypeScript adapter.${c.reset}`,
    );
    return false;
  }

  const skipInstall = hasFlag(process.argv, "--skip-install");

  console.log(`${c.bold}${c.cyan}Scaffolding kit plugin...${c.reset}\n`);

  const result = await createPlugin({
    name: pluginName,
    cwd: process.cwd(),
    skipInstall,
  });

  if (result.success) {
    console.log(`  ${c.green}✓${c.reset} ${result.message}`);
    console.log();
    console.log(`${c.bold}Next steps:${c.reset}`);
    for (const step of result.nextSteps) {
      console.log(`  ${c.dim}${step}${c.reset}`);
    }
    console.log();
    console.log(`${c.dim}See PLUGIN_AUTHORING.md for full documentation.${c.reset}`);
    return true;
  }

  return false;
}

export async function cmdClone(): Promise<boolean> {
  const args = process.argv.slice(2);
  const repoUrl = args[1];
  const targetDir = args[2];
  const noSetup = hasFlag(args, "--no-setup");
  const environment = flagValue(args, "--env") ?? "default";

  if (!repoUrl) {
    console.error(`${c.red}Usage: kit clone <repo-url> [directory]${c.reset}`);
    console.error();
    console.error(`${c.dim}Options:${c.reset}`);
    console.error(`${c.dim}  --no-setup           Skip running kit setup after cloning${c.reset}`);
    console.error(
      `${c.dim}  --env <name>         Environment to use for setup (default: "default")${c.reset}`,
    );
    console.error();
    console.error(`${c.dim}Example:${c.reset}`);
    console.error(`${c.dim}  kit clone https://github.com/sandstream/example my-project${c.reset}`);
    console.error(
      `${c.dim}  kit clone https://github.com/sandstream/example my-project --env production${c.reset}`,
    );
    console.error(
      `${c.dim}  kit clone https://github.com/sandstream/example my-project --no-setup${c.reset}`,
    );
    return false;
  }

  console.log(`${c.bold}${c.cyan}kit clone${c.reset}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);

  const cloneResult = await cloneRepository({
    repoUrl,
    targetDir,
    noSetup,
    environment,
    cwd: process.cwd(),
  });

  if (!cloneResult.success) {
    console.error(`${c.red}✗ Clone failed: ${cloneResult.message}${c.reset}`);
    return false;
  }

  console.log(`${c.green}✓ Repository cloned to ${cloneResult.clonedPath}${c.reset}`);
  console.log();

  if (!cloneResult.haskitToml) {
    console.log(`${c.yellow}⚠ No .kit.toml found in repository.${c.reset}`);
    console.log(
      `${c.dim}Create one with 'cd ${cloneResult.clonedPath} && kit init' to set up kit.${c.reset}`,
    );
    console.log();
    return true;
  }

  if (cloneResult.setupSkipped) {
    console.log(`${c.yellow}Setup skipped (--no-setup flag set).${c.reset}`);
    console.log(`${c.dim}Run: cd ${cloneResult.clonedPath} && kit setup${c.reset}`);
    console.log();
    return true;
  }

  // Run setup in the cloned directory
  console.log(`${c.bold}Running setup in cloned repository...${c.reset}\n`);

  const originalCwd = process.cwd();
  try {
    process.chdir(cloneResult.clonedPath);
    const setupOk = await cmdSetup();
    process.chdir(originalCwd);

    if (!setupOk) {
      console.log(`${c.yellow}Clone completed but setup failed. See above for details.${c.reset}`);
    }
    return setupOk;
  } catch (err) {
    process.chdir(originalCwd);
    console.error(
      `${c.red}Error during setup: ${err instanceof Error ? err.message : String(err)}${c.reset}`,
    );
    return false;
  }
}

export async function cmdRun(): Promise<boolean> {
  const args = process.argv.slice(2);

  // Find the -- separator
  const doubleDashIndex = args.indexOf("--");
  if (doubleDashIndex === -1 || doubleDashIndex === args.length - 1) {
    console.error(`${c.red}Usage: kit run -- <command> [args...]${c.reset}`);
    console.error();
    console.error(`${c.dim}Options:${c.reset}`);
    console.error(
      `${c.dim}  --env <name>    Environment to use (dev, staging, production, etc.)${c.reset}`,
    );
    console.error();
    console.error(`${c.dim}Example:${c.reset}`);
    console.error(`${c.dim}  kit run -- pnpm test${c.reset}`);
    console.error(`${c.dim}  kit run --env staging -- node scripts/migrate.js${c.reset}`);
    return false;
  }

  // `--env <name>` before the `--` is documented in the usage text above and does NOT select an
  // environment: the block that used to sit here computed the flag's index, compared it against
  // the separator, and had an empty body — "reserved for future use". Removed rather than left
  // looking like parsing, because a documented flag whose handler is empty is the same shape as a
  // flag that silently does nothing. Wiring it means passing the name into `executeCommand`, which
  // is a behaviour change with its own decision to make.
  //
  // Extract command and args after --
  const commandArgs = args.slice(doubleDashIndex + 1);

  const result = await executeCommand({
    commandArgs,
    cwd: process.cwd(),
    inheritEnv: true,
  });

  process.exitCode = result.exitCode;
  return result.exitCode === 0;
}

export async function cmdOpen(): Promise<boolean> {
  const args = process.argv.slice(2);
  const serviceName = args[1];

  // Load env from .env.local for dashboard URL resolution
  const env: Record<string, string> = {};
  try {
    const envPath = resolve(process.cwd(), ".env.local");
    const { readFileSync } = await import("node:fs");
    const envContent = readFileSync(envPath, "utf-8");
    const lines = envContent.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) continue;
      const key = trimmed.substring(0, eqIndex);
      const value = trimmed.substring(eqIndex + 1);
      env[key] = value;
    }
  } catch {
    // .env.local not found — continue with empty env
  }

  if (!serviceName || serviceName.startsWith("-")) {
    // No service specified — show menu
    console.log(`${c.bold}kit open${c.reset} — open service dashboards\n`);
    console.log(`${c.bold}Usage:${c.reset}`);
    console.log(`  kit open <service>${c.dim} — open service dashboard${c.reset}`);
    console.log();

    const services = listServices();
    const maxLen = Math.max(...services.map((s) => s.name.length));

    console.log(`${c.bold}Available services:${c.reset}`);
    for (const service of services) {
      const pad = " ".repeat(maxLen - service.name.length + 2);
      console.log(`  ${c.green}${service.name}${c.reset}${pad}${c.dim}${service.label}${c.reset}`);
    }
    console.log();
    console.log(`${c.dim}Example: kit open stripe${c.reset}`);
    return true;
  }

  const result = await openService(serviceName, env);

  if (result.success) {
    console.log(`${c.green}✓${c.reset} ${result.message}`);
    return true;
  } else {
    console.error(`${c.red}✗${c.reset} ${result.message}`);
    return false;
  }
}
