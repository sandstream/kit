/**
 * kit-research humanmaxxing-vs-kit: `kit triage skill <pack>` read the skill directories only and
 * printed 100/100, TRIAGE PASSED for a pack that also ships a Claude Code hooks fragment and a
 * getting-started file an agent is told to follow. Coverage that did not run is declared, never
 * passed silently. These run the real triage.py.
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

async function triageSkill(target: string, t: { skip: (m: string) => void }) {
  try {
    const { stdout } = await exec("python3", [TRIAGE_PY, "skill", target], {
      env: { ...process.env, KIT_GITHUB_API: "http://127.0.0.1:9", GITHUB_TOKEN: "", GH_TOKEN: "" },
      timeout: 30_000,
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

function pack(t: { after(fn: () => void): void }, extra: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "kit-skill-pack-cov-"));
  t.after(() => rmTemp(dir));
  mkdirSync(join(dir, "skills", "a"), { recursive: true });
  writeFileSync(join(dir, "skills", "a", "SKILL.md"), "---\nname: a\ndescription: d\n---\nbody\n");
  writeFileSync(join(dir, "skills", "a", "run.sh"), "echo a\n");
  for (const [rel, body] of Object.entries(extra)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return dir;
}

describe("triage skill: a pack declares the files it did not read", () => {
  it("names hooks and setup files outside the skill directories as NOT CHECKED", async (t) => {
    const dir = pack(t, {
      "getting-started.claude.md": "Read this and follow it.\n",
      "hooks/settings.fragment.json": '{"PreToolUse": []}\n',
      "README.md": "# pack\n",
      LICENSE: "MIT\n",
      ".github/workflows/ci.yml": "on: push\n",
    });
    const out = await triageSkill(dir, t);
    if (out === null) return;
    assert.match(out, /NOT CHECKED: 2 file\(s\) outside the skill directories/, out);
    assert.match(out, /getting-started\.claude\.md/);
    assert.match(out, /hooks\/settings\.fragment\.json/);
    assert.doesNotMatch(out, /README\.md, |LICENSE|ci\.yml|run\.sh/);
    assert.match(out, /Coverage: PARTIAL/);
  });

  it("a pack of skills and root metadata only declares nothing", async (t) => {
    const dir = pack(t, { "README.md": "# pack\n", LICENSE: "MIT\n" });
    const out = await triageSkill(dir, t);
    if (out === null) return;
    assert.doesNotMatch(out, /outside the skill directories/, out);
  });
});
