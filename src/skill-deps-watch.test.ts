import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  findSkillProjects,
  watchSkillDeps,
  type WatchDeps,
  type SkillDepsCheck,
} from "./skill-deps-watch.js";

const made: string[] = [];
function root(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kit-skillwatch-")));
  made.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A skill with scripts/package.json, a lockfile and an installed node_modules. */
function skill(skills: string, name: string, where = "scripts", lock = true): string {
  const dir = join(skills, name, where);
  mkdirSync(join(dir, "node_modules", "x"), { recursive: true });
  writeFileSync(join(dir, "package.json"), '{"dependencies":{"x":"1.0.0"}}');
  if (lock) writeFileSync(join(dir, "package-lock.json"), '{"lockfileVersion":3}');
  writeFileSync(join(dir, "node_modules", "x", "package.json"), '{"name":"x","version":"1.0.0"}');
  return dir;
}

const clean: SkillDepsCheck = { vulnerabilities: [], majorsBehind: [] };
function deps(
  check: SkillDepsCheck | Error,
  calls: string[] = [],
  now = Date.parse("2026-11-15T12:00:00Z"),
): WatchDeps {
  return {
    now: () => now,
    check: (dir) => {
      calls.push(dir);
      if (check instanceof Error) throw check;
      return check;
    },
  };
}

describe("findSkillProjects", () => {
  it("finds package.json files in a skill or its scripts folder, not inside node_modules", () => {
    const skills = root();
    const a = skill(skills, "a");
    const b = skill(skills, "b", ".");
    mkdirSync(join(skills, "c", "node_modules", "dep"), { recursive: true });
    writeFileSync(join(skills, "c", "node_modules", "dep", "package.json"), "{}");
    assert.deepEqual(findSkillProjects([skills]).sort(), [a, b].sort());
  });

  it("ignores a skill with no lockfile, because npm audit needs one", () => {
    const skills = root();
    skill(skills, "nolock", "scripts", false);
    assert.deepEqual(findSkillProjects([skills]), []);
  });

  it("lists a folder once when two roots are the same folder", () => {
    const skills = root();
    const dir = skill(skills, "a");
    assert.deepEqual(findSkillProjects([skills, skills]), [dir]);
  });

  it("ignores a root that does not exist", () => {
    assert.deepEqual(findSkillProjects([join(tmpdir(), "kit-no-such-root-xyz")]), []);
  });
});

describe("watchSkillDeps", () => {
  it("is silent when nothing is wrong", () => {
    const skills = root();
    skill(skills, "ok");
    assert.deepEqual(
      watchSkillDeps({ roots: [skills], cache: join(root(), "c.json") }, deps(clean)),
      [],
    );
  });

  it("names the skill, the packages and the severity of a known vulnerability", () => {
    const skills = root();
    const dir = skill(skills, "tillganglighet");
    const bad: SkillDepsCheck = {
      vulnerabilities: [
        { package: "axe-core", severity: "high", title: "x" },
        { package: "playwright", severity: "low", title: "y" },
      ],
      majorsBehind: [],
    };
    const [note, ...rest] = watchSkillDeps(
      { roots: [skills], cache: join(root(), "c.json") },
      deps(bad),
    );
    assert.equal(rest.length, 0);
    assert.match(note, /tillganglighet/);
    assert.match(note, /2 known vulnerabilities/);
    assert.match(note, /1 high/);
    assert.match(note, /axe-core/);
    assert.ok(note.includes(dir));
    assert.match(note, /kit triage npm/);
    assert.doesNotMatch(note, /\u001b\[/);
    assert.doesNotMatch(note, /\n/);
  });

  it("reports a dependency that is a major version behind", () => {
    const skills = root();
    skill(skills, "old");
    const behind: SkillDepsCheck = {
      vulnerabilities: [],
      majorsBehind: [{ package: "playwright", current: "1.58.0", latest: "2.0.0" }],
    };
    const [note] = watchSkillDeps({ roots: [skills], cache: join(root(), "c.json") }, deps(behind));
    assert.match(note, /playwright 1\.58\.0 \(latest 2\.0\.0\)/);
  });
});

describe("watchSkillDeps caching and limits", () => {
  it("checks a skill again only after 24 hours", () => {
    const skills = root();
    const dir = skill(skills, "s");
    const cache = join(root(), "c.json");
    const calls: string[] = [];
    const t0 = Date.parse("2026-11-15T12:00:00Z");
    watchSkillDeps({ roots: [skills], cache }, deps(clean, calls, t0));
    watchSkillDeps({ roots: [skills], cache }, deps(clean, calls, t0 + 23 * 3600_000));
    assert.deepEqual(calls, [dir]);
    watchSkillDeps({ roots: [skills], cache }, deps(clean, calls, t0 + 25 * 3600_000));
    assert.deepEqual(calls, [dir, dir]);
  });

  it("repeats a cached finding without asking the network again", () => {
    const skills = root();
    skill(skills, "s");
    const cache = join(root(), "c.json");
    const bad: SkillDepsCheck = {
      vulnerabilities: [{ package: "x", severity: "critical", title: "t" }],
      majorsBehind: [],
    };
    const calls: string[] = [];
    const first = watchSkillDeps({ roots: [skills], cache }, deps(bad, calls));
    const second = watchSkillDeps({ roots: [skills], cache }, deps(new Error("offline"), calls));
    assert.equal(calls.length, 1);
    assert.deepEqual(second, first);
  });
});

describe("watchSkillDeps failure handling", () => {
  it("checks again when the lockfile changed, even inside 24 hours", () => {
    const skills = root();
    const dir = skill(skills, "s");
    const cache = join(root(), "c.json");
    const calls: string[] = [];
    watchSkillDeps({ roots: [skills], cache }, deps(clean, calls));
    writeFileSync(join(dir, "package-lock.json"), '{"lockfileVersion":3,"changed":true}');
    watchSkillDeps({ roots: [skills], cache }, deps(clean, calls));
    assert.equal(calls.length, 2);
  });

  it("stays silent and caches nothing when the check fails, for example offline", () => {
    const skills = root();
    skill(skills, "s");
    const cache = join(root(), "c.json");
    assert.deepEqual(watchSkillDeps({ roots: [skills], cache }, deps(new Error("offline"))), []);
    assert.throws(() => readFileSync(cache), { code: "ENOENT" });
  });

  it("writes no cache in read-only mode but still reports", () => {
    const skills = root();
    skill(skills, "s");
    const cache = join(root(), "c.json");
    const bad: SkillDepsCheck = {
      vulnerabilities: [{ package: "x", severity: "high", title: "t" }],
      majorsBehind: [],
    };
    const notes = watchSkillDeps({ roots: [skills], cache, readOnly: true }, deps(bad));
    assert.equal(notes.length, 1);
    assert.throws(() => readFileSync(cache), { code: "ENOENT" });
  });

  it("ignores a cache file it cannot read", () => {
    const skills = root();
    skill(skills, "s");
    const cache = join(root(), "c.json");
    writeFileSync(cache, "{ not json");
    const calls: string[] = [];
    watchSkillDeps({ roots: [skills], cache }, deps(clean, calls));
    assert.equal(calls.length, 1);
  });

  it("stops asking once the time budget is spent and says so", () => {
    const skills = root();
    skill(skills, "a");
    skill(skills, "b");
    skill(skills, "c");
    let clock = 0;
    const slow: WatchDeps = {
      now: () => clock,
      check: () => {
        clock += 20_000;
        return clean;
      },
    };
    const notes = watchSkillDeps(
      { roots: [skills], cache: join(root(), "c.json"), budgetMs: 30_000 },
      slow,
    );
    assert.equal(notes.length, 1);
    assert.match(notes[0], /not checked/);
  });
});
