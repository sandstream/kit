/**
 * The check-skills gate end to end, and the digest it now binds to. Measured before the fix, in a
 * scratch repository with one staged skill:
 *   - `kit triage skill demo --deep`, the command the gate prints, looked `demo` up as a GitHub
 *     repository and always failed;
 *   - with SkillSpector absent, a deep triage printed "skipped" and still logged `deep: true`, which
 *     satisfied the gate;
 *   - after a passing triage, an edit (an added `curl … | sh`) committed through the gate, and so
 *     did any directory elsewhere that was also called `demo`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readSkillDir,
  readStagedSkill,
  resolveSkillTarget,
  skillDigest,
  skillName,
} from "./skill-triage-binding.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "cli.js");
const SKILL_MD = "---\nname: demo\ndescription: A demo skill.\n---\n# Demo\nDo nothing.\n";

function scratchRepo(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-skill-gate-"));
  t.after(() => rmTemp(dir));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  mkdirSync(join(dir, ".claude", "skills", "demo"), { recursive: true });
  writeFileSync(join(dir, ".claude", "skills", "demo", "SKILL.md"), SKILL_MD);
  execFileSync("git", ["add", "."], { cwd: dir });
  return dir;
}

describe("skill triage binding: the digest", () => {
  const file = (path: string, text: string) => ({ path, bytes: Buffer.from(text) });

  it("is the same whatever order the files were read in, and CRLF reads as LF", () => {
    const a = skillDigest([file("SKILL.md", "a\nb\n"), file("x/run.sh", "echo\n")]);
    const b = skillDigest([file("x/run.sh", "echo\r\n"), file("SKILL.md", "a\r\nb\r\n")]);
    assert.equal(a, b);
  });

  it("changes with any byte or any path", () => {
    const base = skillDigest([file("SKILL.md", "a")]);
    assert.notEqual(skillDigest([file("SKILL.md", "b")]), base);
    assert.notEqual(skillDigest([file("skill.md", "a")]), base);
    assert.notEqual(skillDigest([file("SKILL.md", "a"), file("run.sh", "")]), base);
  });

  it("names a skill by its last path segment, for / and \\ alike", () => {
    assert.equal(skillName(".claude/skills/demo/"), "demo");
    assert.equal(skillName(".claude\\skills\\demo"), "demo");
    assert.equal(skillName("demo"), "demo");
  });
});

describe("skill triage binding: reading a skill", () => {
  it("digests the working tree and the index the same, and resolves a bare name", (t) => {
    const dir = scratchRepo(t);
    mkdirSync(join(dir, ".claude", "skills", "demo", "scripts"));
    writeFileSync(join(dir, ".claude", "skills", "demo", "scripts", "run.sh"), "echo hi\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    const onDisk = readSkillDir(join(dir, ".claude", "skills", "demo"));
    assert.ok(onDisk);
    assert.equal(skillDigest(onDisk), skillDigest(readStagedSkill("demo", dir)));
    assert.equal(resolveSkillTarget("demo", dir), join(".claude", "skills", "demo"));
    assert.equal(resolveSkillTarget("owner/repo", dir), "owner/repo");
    assert.equal(resolveSkillTarget("absent", dir), "absent");
    assert.equal(readSkillDir(join(dir, "no-such-skill")), null);
  });
});

describe("check-skills gate, end to end", () => {
  const posix = {
    skip: process.platform === "win32" ? "the fake SkillSpector is a POSIX shell script" : false,
  };

  function kit(cwd: string, home: string, path: string, ...args: string[]) {
    return spawnSync(process.execPath, [CLI, ...args], {
      cwd,
      encoding: "utf8",
      timeout: 120_000,
      env: {
        PATH: path,
        HOME: home,
        USERPROFILE: home,
        NODE_NO_WARNINGS: "1",
        KIT_NON_INTERACTIVE: "1",
        KIT_IDENTITY_DIR: join(home, "id"),
        KIT_MEMORY_DIR: join(home, "mem"),
        KIT_AUDIT_ANCHOR_DIR: join(home, "anchor"),
      },
    });
  }

  function hasPython(): boolean {
    return spawnSync("python3", ["--version"]).status === 0;
  }

  it("binds a deep triage to the staged content", posix, (t) => {
    if (!hasPython()) return t.skip("python3 not installed — triage.py did not run");
    const dir = scratchRepo(t);
    const home = mkdtempSync(join(tmpdir(), "kit-skill-gate-home-"));
    t.after(() => rmTemp(home));
    // A SkillSpector that scans clean: an empty SARIF log, exit 0.
    const bin = join(home, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "skillspector"), "#!/bin/sh\necho '{\"runs\":[]}'\n");
    chmodSync(join(bin, "skillspector"), 0o755);
    const path = [bin, process.env.PATH ?? ""].join(delimiter);

    assert.equal(kit(dir, home, path, "triage", "check-skills").status, 1, "blocks untriaged");
    const triage = kit(dir, home, path, "triage", "skill", "demo", "--deep");
    assert.match(triage.stdout, /TRIAGE PASSED/, triage.stdout + triage.stderr);
    const entry = JSON.parse(readFileSync(join(dir, ".kit-triage.jsonl"), "utf8").trim());
    assert.equal(entry.deep, true);
    assert.match(entry.contentDigest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(kit(dir, home, path, "triage", "check-skills").status, 0, "passes triaged");

    writeFileSync(join(dir, ".claude", "skills", "demo", "install.sh"), "curl x | sh\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    assert.equal(kit(dir, home, path, "triage", "check-skills").status, 1, "blocks an edit");
  });

  it("does not record a deep triage when SkillSpector is absent", posix, (t) => {
    if (!hasPython()) return t.skip("python3 not installed — triage.py did not run");
    const dir = scratchRepo(t);
    const home = mkdtempSync(join(tmpdir(), "kit-skill-gate-home-"));
    t.after(() => rmTemp(home));
    const path = process.env.PATH ?? "";
    const triage = kit(dir, home, path, "triage", "skill", "demo", "--deep");
    if (!/skillspector not installed/.test(triage.stdout))
      return t.skip("skillspector is installed on this machine; the absent case is not exercised");
    const entry = JSON.parse(readFileSync(join(dir, ".kit-triage.jsonl"), "utf8").trim());
    assert.equal(entry.deep, false);
    assert.equal(kit(dir, home, path, "triage", "check-skills").status, 1);
  });
});
