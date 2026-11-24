/**
 * AGENTS.md ↔ CLAUDE.md: every agent that works on this repo gets the same rules.
 *
 * Claude Code reads CLAUDE.md; Codex, OpenCode and the other agents in docs/FEATURES.md that share
 * the cross-tool file read AGENTS.md. AGENTS.md had only the managed kit block and the ADR section,
 * so an agent reading it was never told to check paths on macOS and Windows, to write changelog
 * fragments instead of editing CHANGELOG.md, to run `node scripts/prepush.mjs`, or to keep session
 * URLs out of public issue and PR bodies. kit is meant to work with Codex as well as Claude, so the
 * two files are kept identical, and a rule for one agent only is worded for any agent instead.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("agent instruction files", () => {
  it("AGENTS.md says exactly what CLAUDE.md says", () => {
    const claude = readFileSync(resolve(root, "CLAUDE.md"), "utf8").replace(/\r\n/g, "\n");
    const agents = readFileSync(resolve(root, "AGENTS.md"), "utf8").replace(/\r\n/g, "\n");
    const headings = (text: string) => text.split("\n").filter((line) => line.startsWith("## "));
    assert.deepEqual(
      headings(agents),
      headings(claude),
      "AGENTS.md is missing a section CLAUDE.md has",
    );
    assert.equal(agents, claude, "edit both files: AGENTS.md is what Codex and other agents read");
  });
});
