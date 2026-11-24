/**
 * Dispatched subcommands ↔ their help and reference rows.
 *
 * src/subcommand-help.test.ts holds the docs → help direction: a `kit <cmd> <sub>` row in
 * docs/COMMANDS.md needs a help entry. Nothing held the other direction. `kit triage` ran
 * twenty types and `kit triage --help` listed fifteen: brew, mcp, model, plugin and
 * vault-config printed only the parent's one-liner, were absent from contracts/kit.opencli.json,
 * and three of them were named in no document. `kit escalate pr` was the same.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMAND_HELP } from "./cli.js";
import { TRIAGE_TYPES } from "./commands/triage.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The `kit triage <type>` names in the first cell of each docs/COMMANDS.md table row. */
function documentedTriageTypes(): Set<string> {
  const md = readFileSync(resolve(root, "docs", "COMMANDS.md"), "utf8");
  const types = new Set<string>();
  for (const line of md.split("\n")) {
    if (!line.startsWith("|")) continue;
    const firstCell = line.split(/(?<!\\)\|/)[1] ?? "";
    for (const m of firstCell.matchAll(/`kit triage ([a-z][a-z0-9-]*)/g)) types.add(m[1]!);
  }
  return types;
}

describe("dispatched subcommands have their own help", () => {
  it("every type kit triage runs has a `kit triage <type> --help` entry", () => {
    const missing = TRIAGE_TYPES.filter((type) => !(`triage ${type}` in COMMAND_HELP));
    assert.deepEqual(missing, [], "add these to src/subcommand-help.ts");
  });

  it("every type kit triage runs has a row in docs/COMMANDS.md", () => {
    const documented = documentedTriageTypes();
    const missing = TRIAGE_TYPES.filter((type) => !documented.has(type));
    assert.deepEqual(missing, [], "add a row to the Triage table in docs/COMMANDS.md");
  });

  it("kit escalate pr has its own help entry", () => {
    assert.ok("escalate pr" in COMMAND_HELP, "add `escalate pr` to src/subcommand-help.ts");
  });
});
