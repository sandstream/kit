import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { COMMANDS, COMMAND_HELP } from "./cli.js";

// Guards against the `kit help` ↔ dispatch drift that hid 11 commands
// (health, scan, sentinel, supply-chain, agent-audit, gha-audit, sbom, ingest,
// verify-provenance, auth, security) from `kit help` and from did-you-mean.
// COMMANDS is the single source of truth; help must cover it exactly.
describe("command surface", () => {
  it("every dispatched command has a COMMAND_HELP entry", () => {
    const missing = Object.keys(COMMANDS).filter(
      (cmd) => !COMMAND_HELP[cmd] || COMMAND_HELP[cmd].length === 0,
    );
    assert.deepEqual(
      missing,
      [],
      `commands dispatched but missing from kit help: ${missing.join(", ")}`,
    );
  });

  it("no COMMAND_HELP entry points at a command that is not dispatched", () => {
    // help/version/completions are handled before the dispatch table (special-cased in main()).
    const known = new Set([...Object.keys(COMMANDS), "help", "version", "completions"]);
    const stale = Object.keys(COMMAND_HELP)
      .map((key) => key.split(" ")[0])
      .filter((top) => !known.has(top));
    assert.deepEqual(
      [...new Set(stale)],
      [],
      `stale help entries for unknown commands: ${stale.join(", ")}`,
    );
  });
});
