/**
 * `kit plugin <list|search|info|install|scaffold|tags>` — plugin
 * discovery + management CLI dispatch. Extracted from cli.ts
 * (codebase-review follow-up). Registry logic lives in plugins.ts;
 * scaffolding in create-plugin.ts — this module is the argv-facing shell.
 */

import {
  searchPlugins,
  listPlugins,
  getPluginInfo,
  getAllTags,
  formatPluginForDisplay,
  isPluginInstalled,
  installPlugin,
} from "./plugins.js";
import { createPlugin } from "./create-plugin.js";
import { c } from "./utils/colors.js";

export async function cmdPlugin(): Promise<boolean> {
  const subcommand = process.argv[3];
  const args = process.argv.slice(4);

  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    console.log(`${c.bold}kit plugin${c.reset} — discover and manage kit plugins\n`);
    console.log(`${c.bold}Usage:${c.reset}`);
    console.log(`  kit plugin list ${c.dim}[--tag TAG]${c.reset}      List all available plugins`);
    console.log(`  kit plugin search <query>            Search for plugins by name/description`);
    console.log(`  kit plugin info <name>               Show detailed info about a plugin`);
    console.log(`  kit plugin install <name>            Install a plugin`);
    console.log(`  kit plugin scaffold <name>           Create a new plugin from template`);
    console.log(`  kit plugin tags                      List all available plugin tags\n`);
    console.log(`${c.dim}Examples:${c.reset}`);
    console.log(`  kit plugin search stripe             # Search for stripe plugins`);
    console.log(`  kit plugin list --tag database       # Show all database adapters`);
    console.log(`  kit plugin info stripe/payments      # Get plugin details`);
    console.log(`  kit plugin install stripe/payments   # Install a plugin`);
    console.log(`  kit plugin scaffold my-service       # Create a plugin package`);
    return true;
  }

  try {
    switch (subcommand) {
      case "list": {
        const tagIndex = args.indexOf("--tag");
        const tag = tagIndex !== -1 ? args[tagIndex + 1] : undefined;

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

      case "search": {
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

      case "info": {
        const name = args[0];
        if (!name) {
          console.error(`${c.red}Error: plugin name required${c.reset}`);
          return false;
        }

        const plugin = getPluginInfo(name);
        if (!plugin) {
          console.error(`${c.red}Error: plugin not found: ${name}${c.reset}`);
          return false;
        }

        console.log(`${c.bold}Plugin Details${c.reset}\n`);
        console.log(formatPluginForDisplay(plugin, true));
        return true;
      }

      case "install": {
        const name = args[0];
        if (!name) {
          console.error(`${c.red}Error: plugin name required${c.reset}`);
          return false;
        }

        const plugin = getPluginInfo(name);
        if (!plugin) {
          console.error(`${c.red}Error: plugin not found: ${name}${c.reset}`);
          return false;
        }

        const isInstalled = await isPluginInstalled(plugin.package || name);
        if (isInstalled) {
          console.log(`${c.green}✓${c.reset} Plugin already installed: ${name}`);
          return true;
        }

        console.log(`${c.dim}Installing ${name}...${c.reset}`);
        const result = await installPlugin(name, plugin);

        if (result.success) {
          console.log(`${c.green}✓${c.reset} ${result.message}`);
          return true;
        } else {
          console.error(`${c.red}✗${c.reset} ${result.message}`);
          return false;
        }
      }

      case "tags": {
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

      case "scaffold": {
        const name = args[0];
        if (!name) {
          console.error(`${c.red}Error: plugin name required${c.reset}`);
          console.error(`Usage: kit plugin scaffold <name>`);
          console.error(`Example: kit plugin scaffold my-stripe-adapter`);
          return false;
        }

        console.log(`${c.dim}Scaffolding plugin: ${name}...${c.reset}`);
        const result = await createPlugin({
          name,
          cwd: process.cwd(),
          skipInstall: false,
        });

        if (result.success) {
          console.log(`${c.green}✓${c.reset} ${result.message}`);
          console.log(`\n${c.bold}Next steps:${c.reset}`);
          for (const step of result.nextSteps) {
            console.log(`  ${step}`);
          }
          return true;
        } else {
          console.error(`${c.red}✗${c.reset} Failed to create plugin`);
          return false;
        }
      }

      default:
        console.error(`${c.red}Unknown subcommand: ${subcommand}${c.reset}`);
        console.error(`Run 'kit plugin --help' for usage information.`);
        return false;
    }
  } catch (err: unknown) {
    const error = err as Error;
    console.error(`${c.red}Error: ${error.message}${c.reset}`);
    return false;
  }
}
