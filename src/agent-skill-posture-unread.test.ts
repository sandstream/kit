/**
 * The skill posture names project skill folders it does not read (kit-research
 * unslop-anything-vs-kit: a skill under `.cursor/skills`, `.opencode/skills`, `.gemini/skills` or
 * `.github/skills` was absent from `kit agent-audit` with no word said).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentSkillPosture } from "./agent-skill-posture.js";

function withRepo(test: (cwd: string, home: string) => void): void {
  const base = mkdtempSync(join(tmpdir(), "kit-skill-unread-"));
  try {
    mkdirSync(join(base, "repo"));
    mkdirSync(join(base, "home"));
    test(join(base, "repo"), join(base, "home"));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

function skillIn(cwd: string, rel: string, name: string): void {
  const dir = join(cwd, ...rel.split("/"), name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: x\n---\nBody.\n`);
}

const unreadRow = (cwd: string, home: string) =>
  runAgentSkillPosture(cwd, home).find((r) => r.name === "skill posture: folders not read");

describe("skill posture: folders it does not read", () => {
  it("names each unread folder that exists, with its harness and skill count", () => {
    withRepo((cwd, home) => {
      skillIn(cwd, ".cursor/skills", "fixture-a");
      skillIn(cwd, ".cursor/skills", "fixture-b");
      skillIn(cwd, ".opencode/skills", "fixture-c");
      skillIn(cwd, ".gemini/skills", "fixture-d");
      mkdirSync(join(cwd, ".github", "skills"), { recursive: true });
      const row = unreadRow(cwd, home);
      assert.equal(row?.status, "warn");
      for (const part of [
        ".cursor/skills (Cursor, 2 skill(s))",
        ".opencode/skills (OpenCode, 1 skill(s))",
        ".gemini/skills (Gemini CLI, 1 skill(s))",
        ".github/skills (GitHub Copilot, 0 skill(s))",
      ]) {
        assert.ok(row?.detail.includes(part), `${part} in ${row?.detail}`);
      }
    });
  });

  it("names them next to read skills, and never fails the audit", () => {
    withRepo((cwd, home) => {
      skillIn(cwd, ".claude/skills", "fixture-read");
      skillIn(cwd, ".github/skills", "fixture-unread");
      const rows = runAgentSkillPosture(cwd, home);
      assert.match(unreadRow(cwd, home)?.detail ?? "", /^\.github\/skills \(GitHub Copilot/);
      assert.ok(rows.some((r) => r.name.startsWith("skill fixture-read")));
      assert.ok(!rows.some((r) => r.name.includes("fixture-unread")));
      assert.ok(rows.every((r) => r.status !== "fail"));
    });
  });

  it("adds no row when none of those folders exists", () => {
    withRepo((cwd, home) => {
      skillIn(cwd, ".claude/skills", "fixture-read");
      assert.equal(unreadRow(cwd, home), undefined);
    });
  });
});
