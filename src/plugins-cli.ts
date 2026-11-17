/**
 * `kit plugin <list|search|info|install|uninstall|scaffold|tags>` — plugin
 * discovery + management CLI dispatch. Extracted from cli.ts
 * (codebase-review follow-up). Registry logic lives in plugins.ts;
 * scaffolding in create-plugin.ts — this module is the argv-facing shell.
 */

import { flagValue, hasFlag } from "./utils/flags.js";
import {
  searchPlugins,
  listPlugins,
  listProjectPlugins,
  getPluginInfo,
  getAllTags,
  formatPluginForDisplay,
  installPlugin,
  uninstallPlugin,
} from "./plugins.js";
import { createPlugin } from "./create-plugin.js";
import { c } from "./utils/colors.js";

async function showProjectPlugins(tag?: string): Promise<void> {
  const installed = await listProjectPlugins(process.cwd(), tag);
  if (installed.length === 0) {
    console.log(`${c.dim}No official plugins declared or registered in this project${c.reset}`);
    return;
  }
  console.log(`${c.bold}Project Plugins${c.reset} — ${installed.length} found\n`);
  for (const { plugin, declared, registered } of installed) {
    console.log(formatPluginForDisplay(plugin));
    if (registered && !declared) {
      console.log(`    ${c.yellow}Registered adapter; npm package not declared${c.reset}`);
    } else if (registered) {
      console.log(`    ${c.dim}Declared package; adapter registered${c.reset}`);
    } else {
      console.log(`    ${c.dim}Declared package${c.reset}`);
    }
  }
}

function printPluginHelp(): void {
  console.log(`${c.bold}kit plugin${c.reset} — discover and manage kit plugins\n`);
  console.log(`${c.bold}Usage:${c.reset}`);
  console.log(`  kit plugin list ${c.dim}[--tag TAG] [--installed]${c.reset}  List plugins`);
  console.log(`  kit plugin search <query>            Search for plugins by name/description`);
  console.log(`  kit plugin info <name>               Show detailed info about a plugin`);
  console.log(`  kit plugin install <name>            Install a plugin`);
  console.log(`  kit plugin uninstall <name>          Uninstall an official plugin`);
  console.log(`  kit plugin scaffold <name> [--skip-install]  Create a new plugin from template`);
  console.log(`  kit plugin tags                      List all available plugin tags\n`);
  console.log(`${c.dim}Examples:${c.reset}`);
  console.log(`  kit plugin search stripe             # Search for stripe plugins`);
  console.log(`  kit plugin list --tag database       # Show database-tagged packages`);
  console.log(`  kit plugin info railway              # Get plugin details`);
  console.log(`  kit plugin install railway           # Install an adapter plugin`);
  console.log(`  kit plugin uninstall railway         # Remove package and adapter registration`);
  console.log(`  kit plugin scaffold my-service       # Create a plugin package`);
}

/** The first argument as a plugin name, or null after printing the error and any usage lines. */
function requireName(args: string[], usage: string[] = []): string | null {
  const name = args[0];
  if (name) return name;
  console.error(`${c.red}Error: plugin name required${c.reset}`);
  for (const line of usage) console.error(line);
  return null;
}

/** Look a plugin up by name, or print "not found" and return null. */
function findPlugin(name: string): NonNullable<ReturnType<typeof getPluginInfo>> | null {
  const plugin = getPluginInfo(name);
  if (plugin) return plugin;
  console.error(`${c.red}Error: plugin not found: ${name}${c.reset}`);
  return null;
}

async function listCommand(args: string[]): Promise<boolean> {
  const tag = flagValue(args, "--tag");

  if (hasFlag(args, "--installed")) {
    await showProjectPlugins(tag);
    return true;
  }

  const plugins = listPlugins(tag);
  if (plugins.length === 0) {
    console.log(`${c.dim}No plugins found${tag ? ` with tag: ${tag}` : ""}${c.reset}`);
    return true;
  }

  console.log(
    `${c.bold}Available Plugins${tag ? ` (${tag})` : ""}${c.reset} — ${plugins.length} found\n`,
  );

  for (const plugin of plugins) {
    console.log(formatPluginForDisplay(plugin));
  }
  return true;
}

function searchCommand(args: string[]): boolean {
  const query = args.join(" ");
  if (!query) {
    console.error(`${c.red}Error: search query required${c.reset}`);
    return false;
  }

  const results = searchPlugins(query);
  if (results.length === 0) {
    console.log(`${c.dim}No plugins found matching: ${query}${c.reset}`);
    return true;
  }

  console.log(`${c.bold}Search Results${c.reset} for "${query}" — ${results.length} found\n`);

  for (const plugin of results) {
    console.log(formatPluginForDisplay(plugin));
  }
  return true;
}

function infoCommand(args: string[]): boolean {
  const name = requireName(args);
  if (!name) return false;
  const plugin = findPlugin(name);
  if (!plugin) return false;

  console.log(`${c.bold}Plugin Details${c.reset}\n`);
  console.log(formatPluginForDisplay(plugin, true));
  return true;
}

async function installCommand(args: string[]): Promise<boolean> {
  const name = requireName(args);
  if (!name) return false;
  const plugin = findPlugin(name);
  if (!plugin) return false;

  console.log(`${c.dim}Installing ${name}...${c.reset}`);
  const result = await installPlugin(name, plugin);

  if (result.success) {
    console.log(`${c.green}✓${c.reset} ${result.message}`);
    return true;
  }
  console.error(`${c.red}✗${c.reset} ${result.message}`);
  return false;
}

async function uninstallCommand(args: string[]): Promise<boolean> {
  const name = requireName(args, ["Usage: kit plugin uninstall <name>"]);
  if (!name) return false;
  const plugin = findPlugin(name);
  if (!plugin) return false;

  const result = await uninstallPlugin(name, plugin);
  if (result.success) console.log(`${c.green}✓${c.reset} ${result.message}`);
  else console.error(`${c.red}✗${c.reset} ${result.message}`);
  return result.success;
}

function tagsCommand(): boolean {
  const tags = getAllTags();
  console.log(`${c.bold}Available Tags${c.reset} — ${tags.length} categories\n`);

  const columns = 3;
  const maxLen = Math.max(...tags.map((t) => t.length));

  for (let i = 0; i < tags.length; i += columns) {
    const row = tags.slice(i, i + columns);
    console.log(row.map((tag) => tag.padEnd(maxLen + 1)).join("  "));
  }
  return true;
}

async function scaffoldCommand(args: string[]): Promise<boolean> {
  const name = requireName(args, [
    `Usage: kit plugin scaffold <name>`,
    `Example: kit plugin scaffold my-stripe-adapter`,
  ]);
  if (!name) return false;

  console.log(`${c.dim}Scaffolding plugin: ${name}...${c.reset}`);
  const result = await createPlugin({
    name,
    cwd: process.cwd(),
    skipInstall: hasFlag(args, "--skip-install"),
  });

  if (!result.success) {
    console.error(`${c.red}✗${c.reset} Failed to create plugin`);
    return false;
  }
  console.log(`${c.green}✓${c.reset} ${result.message}`);
  console.log(`\n${c.bold}Next steps:${c.reset}`);
  for (const step of result.nextSteps) {
    console.log(`  ${step}`);
  }
  return true;
}

const SUBCOMMANDS: Record<string, (args: string[]) => boolean | Promise<boolean>> = {
  list: listCommand,
  search: searchCommand,
  info: infoCommand,
  install: installCommand,
  uninstall: uninstallCommand,
  tags: tagsCommand,
  scaffold: scaffoldCommand,
};

export async function cmdPlugin(): Promise<boolean> {
  const subcommand = process.argv[3];
  const args = process.argv.slice(4);

  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printPluginHelp();
    return true;
  }

  try {
    const handler = Object.hasOwn(SUBCOMMANDS, subcommand) ? SUBCOMMANDS[subcommand] : undefined;
    if (!handler) {
      console.error(`${c.red}Unknown subcommand: ${subcommand}${c.reset}`);
      console.error(`Run 'kit plugin --help' for usage information.`);
      return false;
    }
    return await handler(args);
  } catch (err: unknown) {
    const error = err as Error;
    console.error(`${c.red}Error: ${error.message}${c.reset}`);
    return false;
  }
}
