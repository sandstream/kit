import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SUBCOMMAND_HELP } from "./subcommand-help.js";
import { COMMANDS, COMMAND_HELP } from "./cli.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Every `kit <cmd> <sub>` that docs/COMMANDS.md documents as a table row, for a dispatched <cmd>. */
function documentedSubcommands(): string[] {
  const md = readFileSync(resolve(root, "docs", "COMMANDS.md"), "utf8");
  const keys = new Set<string>();
  for (const line of md.split("\n")) {
    const m = /^\|\s*`kit ([a-z][a-z0-9-]*) ([a-z][a-z0-9-]*)/.exec(line);
    if (m && m[1]! in COMMANDS) keys.add(`${m[1]} ${m[2]}`);
  }
  return [...keys].sort();
}

describe("subcommand help", () => {
  it("covers every subcommand docs/COMMANDS.md documents, so `--help` never falls back to the parent", () => {
    const documented = documentedSubcommands();
    assert.ok(documented.length > 40, "the doc scan found a plausible number of rows");
    const missing = documented.filter((key) => !(key in COMMAND_HELP));
    assert.deepEqual(missing, [], "add these to src/subcommand-help.ts");
  });

  it("only describes subcommands of commands that exist", () => {
    const orphans = Object.keys(SUBCOMMAND_HELP).filter(
      (key) => key.includes(" ") && !(key.split(" ")[0]! in COMMANDS),
    );
    assert.deepEqual(orphans, []);
  });

  it("gives every entry a non-empty one-line description", () => {
    for (const [key, text] of Object.entries(SUBCOMMAND_HELP)) {
      assert.ok(text.trim().length > 0, key);
      assert.ok(!text.includes("\n"), `${key} must be one line`);
    }
  });
});
