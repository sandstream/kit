import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  invocationPhrase,
  readSkillPostures,
  runAgentSkillPosture,
  toolsPhrase,
} from "./agent-skill-posture.js";
import { parseSkillManifest } from "./skill/test.js";

function skill(root: string, name: string, frontmatter: string): void {
  const dir = join(root, ".claude", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\n${frontmatter}---\nBody.\n`);
}

function fixture(): { cwd: string; home: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), "kit-skill-posture-"));
  const cwd = join(base, "repo");
  const home = join(base, "home");
  mkdirSync(cwd);
  mkdirSync(home);
  skill(cwd, "fixture-audit", "description: Use when sweeping tests.\n");
  skill(
    home,
    "fixture-lint",
    "description: Use when linting.\nallowed-tools: Read, Grep, Bash\ndisable-model-invocation: true\n",
  );
  skill(home, "fixture-notes", "description: Use for notes.\nallowed-tools: []\n");
  skill(home, "fixture-any", "description: Use for all.\nallowed-tools: '*'\n");
  return { cwd, home, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

describe("skill posture phrases", () => {
  it("writes out the spec defaults when a skill declares nothing", () => {
    const m = parseSkillManifest("---\nname: a\ndescription: d\n---\nb");
    assert.deepEqual(toolsPhrase(m), {
      text: "allowed-tools not declared: all tools",
      bounded: false,
    });
    assert.equal(invocationPhrase(m), "model-invocable (default), user-invokable (default)");
  });

  it("prints declared values without the default marker", () => {
    const m = parseSkillManifest(
      "---\nname: a\nallowed-tools: Read, Bash\ndisable-model-invocation: true\nuser-invokable: false\n---\nb",
    );
    assert.deepEqual(toolsPhrase(m), { text: "allowed-tools: Read, Bash", bounded: true });
    assert.equal(invocationPhrase(m), "model-invocation disabled, not user-invokable");
  });
});

describe("runAgentSkillPosture", () => {
  it("lists project and user skills with their tools and invocation", (t) => {
    const f = fixture();
    t.after(f.cleanup);
    const rows = runAgentSkillPosture(f.cwd, f.home);
    const byName = new Map(rows.map((r) => [r.name, r]));
    assert.equal(
      byName.get("skill posture")?.detail,
      "4 skill(s): 1 in this checkout, 3 at user level",
    );
    assert.deepEqual(byName.get("skill fixture-audit (project)"), {
      category: "exposure",
      name: "skill fixture-audit (project)",
      status: "warn",
      detail:
        "allowed-tools not declared: all tools; model-invocable (default), user-invokable (default)",
    });
    assert.equal(byName.get("skill fixture-lint (user)")?.status, "pass");
    assert.equal(
      byName.get("skill fixture-lint (user)")?.detail,
      "allowed-tools: Read, Grep, Bash; model-invocation disabled, user-invokable (default)",
    );
    assert.match(byName.get("skill fixture-notes (user)")?.detail ?? "", /^allowed-tools: none;/);
    assert.equal(byName.get("skill fixture-any (user)")?.status, "warn");
    assert.ok(
      rows.every((r) => r.status !== "fail"),
      "posture never fails the audit",
    );
  });

  it("says so when there are no skills, and reads a checkout that is the home dir once", (t) => {
    const f = fixture();
    t.after(f.cleanup);
    const empty = join(f.cwd, "sub");
    mkdirSync(empty);
    assert.deepEqual(
      runAgentSkillPosture(empty, empty).map((r) => r.detail),
      ["no skills in .claude/skills here or in ~/.claude/skills"],
    );
    assert.equal(readSkillPostures(f.home, f.home).length, 3);
    assert.ok(readSkillPostures(f.home, f.home).every((p) => p.scope === "project"));
  });

  it("strips control characters from a skill directory name", (t) => {
    if (process.platform === "win32") {
      t.skip("Windows does not allow control characters in file names");
      return;
    }
    const f = fixture();
    t.after(f.cleanup);
    skill(f.cwd, "evil\u001b[31m", "allowed-tools: Read\n");
    const names = runAgentSkillPosture(f.cwd, f.home).map((r) => r.name);
    assert.ok(names.includes("skill evil[31m (project)"), names.join(" | "));
  });
});

describe("kit agent-audit prints the skill posture", () => {
  it("shows each skill and keeps exit 0", (t) => {
    const f = fixture();
    t.after(f.cleanup);
    const cli = resolve(dirname(fileURLToPath(import.meta.url)), "cli.js");
    const r = spawnSync(process.execPath, [cli, "agent-audit"], {
      cwd: f.cwd,
      env: { ...process.env, HOME: f.home, USERPROFILE: f.home, NO_COLOR: "1" },
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(
      r.stdout,
      /! skill fixture-audit \(project\) {2}allowed-tools not declared: all tools/,
    );
    assert.match(r.stdout, /✓ skill fixture-lint \(user\) {2}allowed-tools: Read, Grep, Bash/);
  });
});
