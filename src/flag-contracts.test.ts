import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { it } from "node:test";
import { flagsForCommand, flagsWithoutValuesForCommand } from "./flag-surface.js";
import { buildOpenCliDoc } from "./opencli.js";

const moduleUrl = pathToFileURL(
  join(import.meta.dirname, "..", "scripts", "command-flag-contracts.mjs"),
).href;
type ParsedFlags = { flags: string[]; bareFlags: string[] };
type Parse = (value: unknown, verbs: Set<string>, globals: Set<string>) => Map<string, ParsedFlags>;
async function parser(): Promise<Parse> {
  const module = await import(moduleUrl);
  return module.parseFlagContracts;
}
const valid = {
  version: 1,
  commands: {
    observer: {
      flags: [],
      bareFlags: [],
      reason: "The child owns its arguments.",
      tests: ["src/guard-flag-contract.test.ts"],
    },
    report: {
      flags: ["--json"],
      bareFlags: ["--json"],
      reason: "Emit a structured report.",
      tests: ["src/flag-contracts.test.ts"],
    },
  },
};
const verbs = new Set(["observer", "report"]);
const globals = new Set(["--help"]);

it("retains an explicit empty contract and a declared option", async () => {
  const parse = await parser();
  assert.deepEqual(
    [...parse(valid, verbs, globals)],
    [
      ["observer", { flags: [], bareFlags: [] }],
      ["report", { flags: ["--json"], bareFlags: ["--json"] }],
    ],
  );
});

for (const value of [
  { version: 2, commands: valid.commands },
  { version: 1, commands: { missing: valid.commands.report } },
  { version: 1, commands: { report: { ...valid.commands.report, flags: ["--json", "--json"] } } },
  { version: 1, commands: { report: { ...valid.commands.report, flags: ["--help"] } } },
  { version: 1, commands: { report: { ...valid.commands.report, flags: ["--json=true"] } } },
  { version: 1, commands: { report: { ...valid.commands.report, reason: "" } } },
  { version: 1, commands: { report: { ...valid.commands.report, tests: [] } } },
  { version: 1, commands: { report: { ...valid.commands.report, bareFlags: undefined } } },
  { version: 1, commands: { report: { ...valid.commands.report, bareFlags: ["--other"] } } },
  {
    version: 1,
    commands: { report: { ...valid.commands.report, bareFlags: ["--json", "--json"] } },
  },
]) {
  it(`refuses an invalid command flag declaration: ${JSON.stringify(value)}`, async () => {
    const parse = await parser();
    assert.throws(() => parse(value, verbs, globals), /flag contract/i);
  });
}

it("does not treat inherited object names as registered command flags", () => {
  for (const command of ["constructor", "toString", "__proto__"]) {
    assert.equal(flagsForCommand(command), null);
    assert.equal(flagsWithoutValuesForCommand(command), null);
  }
});

it("distinguishes a declared empty value contract from an unreviewed command", () => {
  assert.deepEqual(flagsWithoutValuesForCommand("guard-observe"), []);
  assert.deepEqual(flagsWithoutValuesForCommand("whoami"), ["--json"]);
  assert.equal(flagsWithoutValuesForCommand("check"), null);
});

it("publishes known flags without values without inventing value rules for other flags", () => {
  const commands = buildOpenCliDoc().commands;
  assert.deepEqual(commands.whoami["x-kit-flags-without-values"], [
    "--help",
    "--json",
    "--non-interactive",
    "--version",
  ]);
  assert.deepEqual(commands.check["x-kit-flags-without-values"], [
    "--help",
    "--non-interactive",
    "--version",
  ]);
});
