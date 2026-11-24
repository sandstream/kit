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
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
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
import { warmPython } from "./python-warmup.test-support.js";
import { skillspectorSarif } from "./skillspector-report.test-support.js";

// The first python3 start of a cold Windows job can outlast the 30 s per-run limit.
before(() => warmPython());

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

  it("distinguishes regular files and symbolic links", () => {
    const regular = file("data.txt", "sample");
    const base = skillDigest([regular]);
    assert.notEqual(skillDigest([{ ...regular, symlink: true }]), base);
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
      SystemRoot: process.env.SystemRoot,
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

function delegatePath(home: string, report?: string, code = 0): string {
  const bin = join(home, "bin");
  mkdirSync(bin);
  const scripts = new Map([["mise", "#!/bin/sh\nexit 1\n"]]);
  if (report === undefined) {
    scripts.set(
      "which",
      '#!/bin/sh\n[ "$1" = skillspector ] && exit 1\nexec /usr/bin/which "$@"\n',
    );
  } else {
    writeFileSync(join(home, "report.sarif"), report);
    scripts.set(
      "skillspector",
      `#!/bin/sh\nprintf '%s\\n' "$2" >"$HOME/scanned-path"\ncat "$HOME/report.sarif"\nexit ${code}\n`,
    );
  }
  for (const [name, script] of scripts) {
    writeFileSync(join(bin, name), script);
    chmodSync(join(bin, name), 0o755);
  }
  return [bin, process.env.PATH ?? ""].join(delimiter);
}

describe("deep triage refuses incomplete SkillSpector evidence", () => {
  for (const [label, report, code, message] of [
    ["invalid output", "not a report", 0, /deep scan malformed/i],
    [
      "a blocking risk verdict with a medium finding",
      skillspectorSarif({
        results: [
          { ruleId: "sample", level: "warning", message: { text: "Synthetic medium finding" } },
        ],
      }),
      1,
      /Deep scan blocked/i,
    ],
    ["a nonzero process failure", skillspectorSarif(), 7, /failed with exit code 7/i],
    [
      "partial coverage",
      skillspectorSarif({
        coverage: { status: "partial", isComplete: false, coveragePercent: 75 },
        results: [
          { ruleId: "sample", level: "warning", message: { text: "Synthetic observation" } },
        ],
      }),
      0,
      /Synthetic observation[\s\S]+deep scan partial/i,
    ],
  ] as const) {
    it(`refuses a deep triage receipt for ${label}`, posix, (t) => {
      if (!hasPython()) return t.skip("python3 not installed");
      const dir = scratchRepo(t);
      const home = mkdtempSync(join(tmpdir(), "kit-incomplete-delegate-"));
      t.after(() => rmTemp(home));
      const path = delegatePath(home, report, code);

      const triage = kit(dir, home, path, "triage", "skill", "demo", "--deep");
      assert.equal(triage.status, 1, triage.stdout + triage.stderr);
      assert.match(triage.stdout, message);
      assert.doesNotMatch(
        triage.stdout,
        /no findings|^TRIAGE PASSED$|Deep skill triage passed\./im,
      );
      assert.throws(() => readFileSync(join(dir, ".kit-triage.jsonl")), { code: "ENOENT" });
      assert.equal(kit(dir, home, path, "triage", "check-skills").status, 1);
    });
  }
});

describe("check-skills gate, end to end", () => {
  it("binds a deep triage to the staged content", posix, (t) => {
    if (!hasPython()) return t.skip("python3 is required for base triage");
    const dir = scratchRepo(t);
    const home = mkdtempSync(join(tmpdir(), "kit-skill-gate-home-"));
    t.after(() => rmTemp(home));
    const path = delegatePath(home, skillspectorSarif());

    const untriaged = kit(dir, home, path, "triage", "check-skills");
    assert.equal(untriaged.status, 1);
    assert.match(untriaged.stderr, /missing receipt/);
    const triage = kit(dir, home, path, "triage", "skill", "demo", "--deep");
    assert.equal(triage.status, 0, triage.stdout + triage.stderr);
    assert.match(triage.stdout, /Deep skill triage passed\./, triage.stdout + triage.stderr);
    const scanned = readFileSync(join(home, "scanned-path"), "utf8").trim();
    assert.match(scanned, /kit-skill-scan-/);
    assert.equal(existsSync(scanned), false, "removes the snapshot after the command");
    assert.match(triage.stdout, /No findings within the declared coverage/);
    const log = join(dir, ".kit-triage.jsonl");
    const stored = readFileSync(log, "utf8");
    const entry = JSON.parse(stored.trim());
    assert.equal(entry.deep, true);
    assert.equal(entry.skillScan.runs[0].coveragePercent, 100);
    assert.match(entry.contentDigest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(kit(dir, home, path, "triage", "check-skills").status, 0, "passes triaged");

    for (const [receipt, message] of [
      [{ ...entry, timestamp: "2000-01-01T00:00:00.000Z" }, /expired/],
      [{ ...entry, skillScan: undefined }, /unsupported/],
      [{ ...entry, skillScan: { ...entry.skillScan, version: 2 } }, /unsupported/],
      [{ ...entry, skillScan: { ...entry.skillScan, runs: [] } }, /malformed/],
    ] as const) {
      writeFileSync(log, JSON.stringify(receipt) + "\n");
      const gate = kit(dir, home, path, "triage", "check-skills");
      assert.equal(gate.status, 1);
      assert.match(gate.stderr, message);
    }
    writeFileSync(log, stored);

    writeFileSync(join(dir, ".claude", "skills", "demo", "notes.txt"), "A second skill file.\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    assert.equal(kit(dir, home, path, "triage", "check-skills").status, 1, "blocks an edit");
    const incomplete = kit(dir, home, path, "triage", "skill", "demo", "--deep");
    assert.equal(incomplete.status, 1);
    assert.match(incomplete.stdout, /fewer inspected files/);
    assert.equal(
      readFileSync(log, "utf8"),
      stored,
      "does not replace a receipt with partial evidence",
    );
  });

  it("does not record a deep triage when SkillSpector is absent", posix, (t) => {
    if (!hasPython()) return t.skip("python3 is required for base triage");
    const dir = scratchRepo(t);
    const home = mkdtempSync(join(tmpdir(), "kit-skill-gate-home-"));
    t.after(() => rmTemp(home));
    const path = delegatePath(home);
    const triage = kit(dir, home, path, "triage", "skill", "demo", "--deep");
    assert.equal(triage.status, 1, triage.stdout + triage.stderr);
    assert.match(triage.stdout, /skillspector not installed/);
    assert.throws(() => readFileSync(join(dir, ".kit-triage.jsonl")), { code: "ENOENT" });
    const base = kit(dir, home, path, "triage", "skill", "demo");
    assert.equal(base.status, 0, base.stdout + base.stderr);
    const entry = JSON.parse(readFileSync(join(dir, ".kit-triage.jsonl"), "utf8"));
    assert.equal(entry.deep, false);
    assert.equal(kit(dir, home, path, "triage", "check-skills").status, 1);
  });
});

it("reads staged skill names that Git would quote in line output", (t) => {
  const dir = scratchRepo(t);
  const skill = join(dir, ".claude", "skills", "démon");
  mkdirSync(skill);
  writeFileSync(join(skill, "SKILL.md"), SKILL_MD);
  execFileSync("git", ["add", "."], { cwd: dir });
  const gate = kit(dir, dir, process.env.PATH ?? "", "triage", "check-skills");
  assert.equal(gate.status, 1);
  assert.match(gate.stderr, /démon: missing receipt/);
});

it("does not approve changes when Git cannot read the index", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kit-skill-no-index-"));
  t.after(() => rmTemp(dir));
  const gate = kit(dir, dir, process.env.PATH ?? "", "triage", "check-skills");
  assert.equal(gate.status, 1);
  assert.match(gate.stderr, /Cannot read the Git index/);
});
