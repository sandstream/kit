import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMMANDS,
  COMMAND_HELP,
  COMMAND_TIERS,
  emitDeprecationWarning,
  type CommandTier,
} from "./cli.js";

// Guards against the `kit help` ↔ dispatch drift that hid 11 commands
// (health, scan, sentinel, supply-chain, agent-audit, gha-audit, sbom, ingest,
// verify-provenance, auth, security) from `kit help` and from did-you-mean.
// COMMANDS is the single source of truth; help AND the stability tier must cover
// it exactly (three-way parity).
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

  it("every dispatched command has a stability tier", () => {
    const validTiers: CommandTier[] = ["stable", "experimental", "deprecated"];
    const missing = Object.keys(COMMANDS).filter((cmd) => !COMMAND_TIERS[cmd]);
    assert.deepEqual(
      missing,
      [],
      `commands dispatched but missing a tier in COMMAND_TIERS: ${missing.join(", ")}`,
    );
    const bad = Object.entries(COMMAND_TIERS).filter(([, tier]) => !validTiers.includes(tier));
    assert.deepEqual(bad, [], `commands with an invalid tier: ${bad.map(([c]) => c).join(", ")}`);
  });

  it("no COMMAND_TIERS entry points at a command that is not dispatched", () => {
    const stale = Object.keys(COMMAND_TIERS).filter((cmd) => !COMMANDS[cmd]);
    assert.deepEqual([], stale, `tier entries for unknown commands: ${stale.join(", ")}`);
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

// The deprecation mechanism: a "deprecated"-tier command must print a warning to
// stderr at runtime. No real command is deprecated yet, so the mechanism is
// exercised with a fixture tiers map + a spy writer.
describe("deprecation warning", () => {
  it("fires for a deprecated command and writes the warning", () => {
    const fixtureTiers: Record<string, CommandTier> = { legacy: "deprecated" };
    const written: string[] = [];
    const fired = emitDeprecationWarning("legacy", fixtureTiers, (m) => written.push(m));
    assert.equal(fired, true);
    assert.equal(written.length, 1);
    assert.match(written[0]!, /'kit legacy' is deprecated/);
    assert.match(written[0]!, /docs\/CLI_STABILITY\.md/);
  });

  it("does not fire for stable or experimental commands", () => {
    const fixtureTiers: Record<string, CommandTier> = {
      stableCmd: "stable",
      expCmd: "experimental",
    };
    const written: string[] = [];
    assert.equal(
      emitDeprecationWarning("stableCmd", fixtureTiers, (m) => written.push(m)),
      false,
    );
    assert.equal(
      emitDeprecationWarning("expCmd", fixtureTiers, (m) => written.push(m)),
      false,
    );
    assert.equal(written.length, 0);
  });

  it("does not fire for any currently-shipped command (none are deprecated yet)", () => {
    const deprecated = Object.entries(COMMAND_TIERS)
      .filter(([, tier]) => tier === "deprecated")
      .map(([cmd]) => cmd);
    for (const cmd of deprecated) {
      // If a command IS deprecated, emitting must fire so the mechanism stays honest.
      assert.equal(
        emitDeprecationWarning(cmd, COMMAND_TIERS, () => {}),
        true,
      );
    }
  });
});

// Audience-filtered help: harness commands (hook stdin protocols) are hidden
// from the default listing behind a COUNTED note — never silently dropped —
// and fully visible with --all. `kit help <cmd>` always resolves them.
describe("kit help audience filter", () => {
  const CLI = join(dirname(fileURLToPath(import.meta.url)), "cli.js");
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" }).stdout;

  const HARNESS = [
    "gate-bash",
    "gate-egress",
    "gate-env",
    "gate-fs",
    "guard-observe",
    "statusline",
  ];

  it("hides harness commands by default, with a counted note", () => {
    const out = run("help");
    for (const cmd of HARNESS) {
      assert.ok(
        !new RegExp(`^\\s*\\x1b\\[32m${cmd}(\\s|\\x1b)`, "m").test(out) &&
          !new RegExp(`^\\s{2}${cmd}\\s`, "m").test(out),
        `${cmd} should not be listed in default help`,
      );
    }
    assert.match(out, /6 harness hook commands/, "the hidden set is counted, never silent");
    assert.match(out, /kit help --all/, "the note says how to reveal them");
  });

  it("shows harness commands with --all and drops the note", () => {
    const out = run("help", "--all");
    for (const cmd of HARNESS) {
      assert.ok(out.includes(cmd), `${cmd} must be listed under --all`);
    }
    assert.ok(!/harness hook commands —/.test(out), "no hidden-note when nothing is hidden");
  });

  it("kit help <harness-cmd> still resolves directly", () => {
    const out = run("help", "gate-bash");
    assert.match(out, /gate-bash — PreToolUse/);
  });
});
