/**
 * The repo instruction scan reads every harness file kit declares elsewhere.
 *
 * `kit triage instructions` never scanned a repo copy of Codex's `AGENTS.override.md`, nor
 * `.claude/commands/**` or `.claude/agents/**`, although the user audit (`agent-audit-user.ts`)
 * reads all three at user level and both harnesses load them as instructions. The two lists were
 * kept by hand. This derives the expected files from the user audit itself: it lays out a fake home
 * with one file in each surface `userSurfaces` declares, plus Codex's top-level files, and requires
 * every file `userInstructionFiles` returns to be an instruction file at the same path in a repo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { CODEX_HOME_INSTRUCTIONS, userInstructionFiles, userSurfaces } from "./agent-audit-user.js";
import { INSTRUCTION_NAMES, isInstructionFile } from "./instruction-scan-files.js";
import { agentFileKind } from "./pull-agent-files.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

function put(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "x\n");
}

describe("instruction scan: parity with the harness files kit declares", () => {
  it("names every user-level instruction file the user audit reads, at its repo path", (t) => {
    const home = mkdtempSync(join(tmpdir(), "kit-instr-parity-"));
    t.after(() => rmTemp(home));
    // A skill's entry point is SKILL.md; its other files load on demand and the scan names it by SKILL.md.
    for (const s of userSurfaces(home, {}))
      put(join(s.dir, "nested", basename(s.dir) === "skills" ? "SKILL.md" : "probe.md"));
    put(join(home, ".claude", "CLAUDE.md"));
    for (const n of CODEX_HOME_INSTRUCTIONS) put(join(home, ".codex", n));
    const files = userInstructionFiles(home, {}).map((f) =>
      relative(home, f.abs).split(sep).join("/"),
    );
    assert.ok(files.length >= userSurfaces(home, {}).length + 2, files.join(", "));
    const missing = files.filter((rel) => !isInstructionFile(rel));
    assert.deepEqual(missing, [], "the repo instruction scan skips files the user audit reads");
  });

  it("names Claude Code commands and subagents, nested or not, and not other .claude files", () => {
    for (const p of [
      ".claude/commands/deploy.md",
      ".claude/commands/ops/release.md",
      ".claude/agents/reviewer.md",
      "pkg/.claude/agents/a/b.md",
      "AGENTS.override.md",
      "svc/AGENTS.override.md",
    ])
      assert.equal(isInstructionFile(p), true, p);
    for (const p of [".claude/commands/run.sh", ".claude/hooks/x.md", "docs/commands/x.md"])
      assert.equal(isInstructionFile(p), false, p);
  });

  it("verify-pull flags every name the instruction scan reads", () => {
    for (const name of INSTRUCTION_NAMES) assert.notEqual(agentFileKind(`sub/${name}`), null, name);
    assert.equal(agentFileKind(".claude/rules/x.md"), "agent rules");
  });
});
