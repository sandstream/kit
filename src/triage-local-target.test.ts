/**
 * kit-research artex-vs-kit, two triage defects:
 *
 *   kit triage repo /home/user/kit   -> queried GitHub for the repo `home/user`, and a stub that
 *                                       answered made it print 100/100, TRIAGE PASSED
 *   kit triage skill <dir>           -> accepted `## name: x` (a YAML comment) as frontmatter
 *
 * These run the real triage.py. Local-path refusals happen before any request, so no server
 * is needed; `KIT_GITHUB_API` points at a closed port so a regression cannot reach GitHub.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { rmTemp } from "./temp-cleanup.test-support.js";

const exec = promisify(execFile);
const TRIAGE_PY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "skills",
  "triage",
  "scripts",
  "triage.py",
);

async function triage(
  args: string[],
  t: { skip: (m: string) => void },
): Promise<{ out: string; code: number } | null> {
  try {
    const { stdout } = await exec("python3", [TRIAGE_PY, ...args], {
      env: { ...process.env, KIT_GITHUB_API: "http://127.0.0.1:9", GITHUB_TOKEN: "", GH_TOKEN: "" },
      timeout: 30_000,
    });
    return { out: stdout, code: 0 };
  } catch (err) {
    const e = err as { code?: string | number; stdout?: string };
    if (e.code === "ENOENT") {
      t.skip("python3 not installed — triage.py's own behaviour is NOT verified in this run");
      return null;
    }
    return { out: e.stdout ?? "", code: typeof e.code === "number" ? e.code : 1 };
  }
}

describe("triage repo: a local path is not a GitHub repo", () => {
  for (const target of [
    "/home/user/kit",
    "./vendor/thing",
    "../sibling",
    "~/code/x",
    "C:\\code\\x",
  ]) {
    it(`refuses ${target} without asking GitHub about another repo`, async (t) => {
      const r = await triage(["repo", target], t);
      if (r === null) return;
      assert.match(r.out, /is a local path, not a GitHub repo/);
      assert.match(r.out, /TRIAGE FAILED/);
    });
  }
});

describe("triage skill: frontmatter is parsed, not substring-matched", () => {
  const cases: Array<[string, string, boolean]> = [
    ["a closed block with both keys", "---\nname: ok\ndescription: fine\n---\nbody\n", true],
    [
      "a heading that only looks like a key",
      "---\n## name: x\n## description: y\n---\nbody\n",
      false,
    ],
    ["a block that never closes", "---\nname: a\ndescription: b\nbody\n", false],
  ];
  for (const [label, content, clean] of cases) {
    it(label, async (t) => {
      const dir = mkdtempSync(join(tmpdir(), "kit-skill-fm-"));
      t.after(() => rmTemp(dir));
      mkdirSync(join(dir, "s"));
      writeFileSync(join(dir, "s", "SKILL.md"), content);
      const r = await triage(["skill", join(dir, "s")], t);
      if (r === null) return;
      if (clean) assert.doesNotMatch(r.out, /frontmatter/, r.out);
      else assert.match(r.out, /frontmatter missing 'name:'/, r.out);
    });
  }
});
