import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSkills, runSkillGate, SNAPSHOT_NAME } from "./skill-run.js";
import { parseSkillManifest, snapshotOf } from "./skill/test.js";

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), "kit-skillgate-"));
  dirs.push(d);
  return d;
}

/** Write a SKILL.md at `<root>/<where>/<name>/SKILL.md`. Returns its directory. */
function writeSkill(
  root: string,
  where: string,
  name: string,
  frontmatter: string,
  body = "Body text that is long enough to be a real skill body.\n",
): string {
  const dir = join(root, where, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n\n# ${name}\n\n${body}`);
  return dir;
}

const GOOD = (name: string): string =>
  `name: ${name}\ndescription: "Does one specific, describable thing for ${name}."\nallowed-tools: Bash`;

/** Pin the snapshot the way `kit skill test --update-snapshot` does. */
function pin(skillDir: string, frontmatter: string, body: string): void {
  const raw = `---\n${frontmatter}\n---\n\n${body}`;
  writeFileSync(
    join(skillDir, SNAPSHOT_NAME),
    JSON.stringify(snapshotOf(parseSkillManifest(raw)), null, 2),
  );
}

describe("discoverSkills", () => {
  it("finds SKILL.md under both skills/ and .claude/skills/", () => {
    const root = repo();
    writeSkill(root, "skills", "alpha", GOOD("alpha"));
    writeSkill(root, ".claude/skills", "beta", GOOD("beta"));
    const found = discoverSkills(root).map((s) => s.path);
    assert.deepEqual(found, [".claude/skills/beta/SKILL.md", "skills/alpha/SKILL.md"]);
  });

  it("ignores markdown that is not a SKILL.md", () => {
    const root = repo();
    mkdirSync(join(root, "skills", "alpha"), { recursive: true });
    writeFileSync(join(root, "skills", "alpha", "README.md"), "# not a skill\n");
    assert.deepEqual(discoverSkills(root), []);
  });

  it("returns an empty list for a repo with no skills directory", () => {
    assert.deepEqual(discoverSkills(repo()), []);
  });
});

describe("runSkillGate", () => {
  it("passes a well-formed skill and names each check after it", () => {
    const root = repo();
    const body = "Body text that is long enough to be a real skill body.\n";
    const dir = writeSkill(root, "skills", "alpha", GOOD("alpha"), body);
    pin(dir, GOOD("alpha"), `# alpha\n\n${body}`);

    const r = runSkillGate(root);
    assert.equal(r.ok, true);
    assert.equal(r.skillCount, 1);
    assert.ok(r.checks.every((c) => c.name.startsWith("alpha: ")));
    assert.ok(r.checks.every((c) => c.files?.[0] === "skills/alpha/SKILL.md"));
    assert.equal(
      r.checks.find((c) => c.name === "alpha: scope")?.status,
      "pass",
      "a bounded allowed-tools list is the passing case",
    );
  });

  it("FAILS a skill that declares no tool scope — the defect this gate was built for", () => {
    const root = repo();
    writeSkill(root, "skills", "alpha", `name: alpha\ndescription: "Does one specific thing."`);
    const r = runSkillGate(root);
    assert.equal(r.ok, false);
    const scope = r.checks.find((c) => c.name === "alpha: scope");
    assert.equal(scope?.status, "fail");
    assert.match(scope!.detail, /allowed-tools/);
    assert.equal(scope?.severity, "medium");
  });

  it("skips honestly when the repo ships no skills — never a silent pass", () => {
    const r = runSkillGate(repo());
    assert.equal(r.ok, true);
    assert.equal(r.skillCount, 0);
    assert.equal(r.checks.length, 1);
    assert.equal(r.checks[0].status, "skip");
    // Not-applicable, not lost coverage: nothing was prevented from running.
    assert.equal(r.checks[0].didNotRun, false);
    assert.match(r.checks[0].detail, /nothing to check/);
  });

  it("warns rather than passes on an unpinned surface, without failing the gate", () => {
    const root = repo();
    writeSkill(root, "skills", "alpha", GOOD("alpha")); // no snapshot pinned
    const r = runSkillGate(root);
    assert.equal(r.ok, true, "an unproven check must not fail the build on its own");
    const reg = r.checks.find((c) => c.name === "alpha: regression");
    assert.equal(reg?.status, "warn", "a skipped check is surfaced, never rendered as a pass");
  });

  it("fails on snapshot drift — silently widening a skill's privileges is caught", () => {
    const root = repo();
    const body = "Body text that is long enough to be a real skill body.\n";
    const dir = writeSkill(root, "skills", "alpha", GOOD("alpha"), body);
    pin(dir, GOOD("alpha"), `# alpha\n\n${body}`);
    // Re-write the skill with a broader scope, leaving the old snapshot in place.
    writeSkill(
      root,
      "skills",
      "alpha",
      `name: alpha\ndescription: "Does one specific, describable thing for alpha."\nallowed-tools: Bash, Write`,
      body,
    );
    const r = runSkillGate(root);
    assert.equal(r.ok, false);
    assert.equal(r.checks.find((c) => c.name === "alpha: regression")?.status, "fail");
  });

  it("compares siblings, so two skills cannot share one trigger unnoticed", () => {
    const root = repo();
    const shared = 'description: "Exactly the same trigger sentence for both skills."';
    writeSkill(root, "skills", "alpha", `name: alpha\n${shared}\nallowed-tools: Bash`);
    writeSkill(root, "skills", "beta", `name: beta\n${shared}\nallowed-tools: Bash`);
    const r = runSkillGate(root);
    assert.equal(r.skillCount, 2);
    const triggers = r.checks.filter((c) => c.name.endsWith(": trigger"));
    assert.equal(triggers.length, 2);
    assert.ok(
      triggers.some((c) => c.status === "fail"),
      "an identical trigger across siblings must be reported, not silently tolerated",
    );
    assert.equal(r.ok, false);
  });

  it("a single bad skill turns the whole gate red", () => {
    const root = repo();
    const body = "Body text that is long enough to be a real skill body.\n";
    const dir = writeSkill(root, "skills", "alpha", GOOD("alpha"), body);
    pin(dir, GOOD("alpha"), `# alpha\n\n${body}`);
    writeSkill(root, "skills", "beta", `name: beta\ndescription: "Does one specific thing."`);
    const r = runSkillGate(root);
    assert.equal(r.ok, false);
    assert.equal(r.checks.find((c) => c.name === "alpha: scope")?.status, "pass");
    assert.equal(r.checks.find((c) => c.name === "beta: scope")?.status, "fail");
  });
});
