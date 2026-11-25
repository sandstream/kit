/**
 * Two triage verdicts that claimed more than was read (kit-research decepticon-vs-kit).
 *
 * E1: `kit triage skill <pack>` reads at most SKILL_PACK_LIMIT
 * (200) skills. A pack of 201 whose last skill fails on its own printed TRIAGE PASSED with exit 0.
 * A pack with unread skills is now TRIAGE INCOMPLETE: never a pass, so the install gate and the
 * exit code treat it as one that did not pass.
 *
 * `kit triage repo` on a local path, or when GitHub refused the API call, ran no probe yet printed
 * "Health score: 55/100", the penalty arithmetic alone. It now says the score was not measured.
 * These run the real triage.py.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { rmTemp } from "./temp-cleanup.test-support.js";
import { warmPython } from "./python-warmup.test-support.js";
import { verdictPassed } from "./triage.js";

before(() => warmPython());

const exec = promisify(execFile);
const TRIAGE_PY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "skills",
  "triage",
  "scripts",
  "triage.py",
);

async function triage(type: string, target: string, t: { skip: (m: string) => void }) {
  try {
    const { stdout } = await exec("python3", ["-I", TRIAGE_PY, type, target], {
      env: { ...process.env, KIT_GITHUB_API: "http://127.0.0.1:9", GITHUB_TOKEN: "", GH_TOKEN: "" },
      timeout: 60_000,
    });
    return stdout;
  } catch (err) {
    const e = err as { code?: string | number; stdout?: string };
    if (e.code === "ENOENT") {
      t.skip("python3 not installed: triage.py's own behaviour is NOT verified in this run");
      return null;
    }
    return e.stdout ?? "";
  }
}

/** `count` neutral skills s001…, plus an optional last skill `zz` with no frontmatter. */
function pack(t: { after(fn: () => void): void }, count: number, badLast: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-skill-pack-limit-"));
  t.after(() => rmTemp(dir));
  for (let i = 1; i <= count; i++) {
    const name = `s${String(i).padStart(3, "0")}`;
    mkdirSync(join(dir, name));
    writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\nbody\n`);
  }
  if (badLast) {
    mkdirSync(join(dir, "zz"));
    writeFileSync(join(dir, "zz", "SKILL.md"), "# zz\nno frontmatter\n");
  }
  return dir;
}

describe("triage skill: a pack over the read limit never passes", () => {
  it("a pack of 201 whose unread skill fails is INCOMPLETE, not PASSED", async (t) => {
    const out = await triage("skill", pack(t, 200, true), t);
    if (out === null) return;
    assert.doesNotMatch(out, /^TRIAGE PASSED$/m);
    assert.match(out, /^TRIAGE INCOMPLETE: 1 of 201 skill\(s\) not read$/m);
    assert.equal(verdictPassed(out), false);
  });

  it("a pack at the limit still passes", async (t) => {
    const out = await triage("skill", pack(t, 200, false), t);
    if (out === null) return;
    assert.match(out, /^TRIAGE PASSED$/m);
    assert.doesNotMatch(out, /INCOMPLETE/);
  });

  it("a failing read skill still makes the pack FAILED, not INCOMPLETE", async (t) => {
    const dir = pack(t, 200, false);
    writeFileSync(join(dir, "s001", "SKILL.md"), "# s001\nno frontmatter\n");
    mkdirSync(join(dir, "s201"));
    writeFileSync(join(dir, "s201", "SKILL.md"), "---\nname: s201\ndescription: d\n---\nbody\n");
    const out = await triage("skill", dir, t);
    if (out === null) return;
    assert.match(out, /^TRIAGE FAILED$/m);
    assert.doesNotMatch(out, /^TRIAGE INCOMPLETE/m);
  });
});

describe("triage repo: no probe ran, no score", () => {
  it("a local path is refused with the score marked not measured", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "kit-repo-unmeasured-"));
    t.after(() => rmTemp(dir));
    const out = await triage("repo", dir, t);
    if (out === null) return;
    assert.match(out, /^Health score: not measured \(no probe ran\)$/m);
    assert.doesNotMatch(out, /Health score: \d+\/100/);
    assert.match(out, /^TRIAGE FAILED$/m);
  });

  it("an unreachable GitHub API is not measured either", async (t) => {
    const out = await triage("repo", "h-example/none", t);
    if (out === null) return;
    assert.match(out, /^Health score: not measured \(no probe ran\)$/m);
    assert.match(out, /^TRIAGE FAILED$/m);
  });
});
