import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isOutboundCandidate, outboundSources, pathKey } from "./outbound-leak-sources.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args], {
    cwd,
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
}

describe("outbound instruction sources", () => {
  it("counts tracked instruction files as public and untracked or ignored ones as private", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-outbound-src-"));
    const home = mkdtempSync(join(tmpdir(), "kit-outbound-home-"));
    try {
      git(dir, "init", "-q");
      writeFileSync(join(dir, "CLAUDE.md"), "public\n");
      writeFileSync(join(dir, ".gitignore"), "CLAUDE.local.md\n.claude/notes/\n");
      git(dir, "add", "CLAUDE.md", ".gitignore");
      git(dir, "commit", "-q", "-m", "init");
      writeFileSync(join(dir, "CLAUDE.local.md"), "local\n");
      writeFileSync(join(dir, "AGENTS.override.md"), "override\n");
      mkdirSync(join(dir, ".claude", "notes"), { recursive: true });
      writeFileSync(join(dir, ".claude", "notes", "plan.md"), "notes\n");
      mkdirSync(join(home, ".claude"), { recursive: true });
      writeFileSync(join(home, ".claude", "CLAUDE.md"), "user claude\n");
      const codex = join(home, "codex-home");
      mkdirSync(codex);
      writeFileSync(join(codex, "AGENTS.md"), "user codex\n");
      const s = outboundSources(dir, home, { CODEX_HOME: codex });
      assert.equal(s.git, true);
      assert.deepEqual(s.publicFiles, ["CLAUDE.md"]);
      assert.deepEqual(s.privates.map((p) => p.shown).sort(), [
        "$CODEX_HOME/AGENTS.md",
        ".claude/notes/plan.md",
        "AGENTS.override.md",
        "CLAUDE.local.md",
        "~/.claude/CLAUDE.md",
      ]);
    } finally {
      rmTemp(dir);
      rmTemp(home);
    }
  });

  it("outside a git worktree, only user-level files are private", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-outbound-nogit-"));
    const home = mkdtempSync(join(tmpdir(), "kit-outbound-home-"));
    try {
      writeFileSync(join(dir, "CLAUDE.local.md"), "local\n");
      mkdirSync(join(home, ".codex"));
      writeFileSync(join(home, ".codex", "AGENTS.override.md"), "codex\n");
      const s = outboundSources(dir, home, {});
      if (s.git) return; // tmpdir sits inside a worktree on this machine; nothing to measure
      assert.deepEqual(s.publicFiles, ["CLAUDE.local.md"]);
      assert.deepEqual(
        s.privates.map((p) => p.shown),
        ["~/.codex/AGENTS.override.md"],
      );
    } finally {
      rmTemp(dir);
      rmTemp(home);
    }
  });
});

describe("outbound path handling", () => {
  it("compares Windows and POSIX spellings as one path, case-folded where the fs folds case", () => {
    assert.equal(pathKey(".claude\\rules\\a.md", "win32"), pathKey(".claude/rules/A.md", "win32"));
    assert.equal(pathKey("CLAUDE.md", "darwin"), "claude.md");
    assert.equal(pathKey("CLAUDE.md", "linux"), "CLAUDE.md");
  });

  it("recognises private candidates under either separator", () => {
    assert.ok(isOutboundCandidate(".claude\\local\\x.md"));
    assert.ok(isOutboundCandidate("sub/AGENTS.override.md"));
    assert.ok(isOutboundCandidate("CLAUDE.local.md"));
    assert.ok(!isOutboundCandidate("docs/readme.md"));
  });
});
