/**
 * triage.py printed the path it checked through Python's default stdout encoding. On Windows a
 * piped stdout is the ANSI code page (cp1252 and the like), so a skill at `pаyments` (with a
 * Cyrillic а) raised UnicodeEncodeError in the report and no verdict line was printed. Found
 * while building kit#1086, whose test had to set PYTHONIOENCODING=utf-8 to get past it.
 *
 * Linux reproduces the Windows pipe by setting PYTHONIOENCODING to a legacy code page: that is the
 * same encoding Python picks there, and it runs on every CI OS.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { rmTemp } from "./temp-cleanup.test-support.js";
import { warmPython } from "./python-warmup.test-support.js";

const exec = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const TRIAGE_PY = resolve(HERE, "..", "skills", "triage", "scripts", "triage.py");
const NAME = "pаyments"; // Cyrillic а: a homoglyph name, not ASCII

let root: string;
let skillDir: string;

before(async () => {
  await warmPython();
  root = mkdtempSync(join(tmpdir(), "kit-triage-enc-"));
  skillDir = join(root, NAME);
  mkdirSync(skillDir);
  const skill = `---\nname: ${NAME}\ndescription: Formats ${NAME} reports. Café.\n---\n\n# ${NAME}\n\nSummarise a report.\n`;
  writeFileSync(join(skillDir, "SKILL.md"), skill, "utf8");
});

after(() => rmTemp(root));

/** A child env whose Python stdout encoding is `encoding`, as a Windows pipe would set it. */
function legacyEnv(encoding: string): NodeJS.ProcessEnv {
  return { ...process.env, PYTHONIOENCODING: encoding, PYTHONUTF8: "0", KIT_GITHUB_API: "http://127.0.0.1:9" };
}

describe("triage.py output encoding", () => {
  for (const encoding of ["cp1252", "ascii"]) {
    it(`prints a non-ASCII skill path under ${encoding} without crashing`, async (t) => {
      let out: { stdout: string; stderr: string };
      try {
        out = await exec("python3", [TRIAGE_PY, "skill", skillDir], {
          env: legacyEnv(encoding),
          encoding: "utf8",
          timeout: 30_000,
        });
      } catch (err) {
        const e = err as { code?: string | number; stderr?: string };
        if (e.code === "ENOENT") {
          t.skip("python3 not installed: triage.py's own behaviour is NOT verified in this run");
          return;
        }
        assert.fail(`triage.py exited ${String(e.code)}:\n${e.stderr ?? ""}`);
      }
      assert.doesNotMatch(out.stderr, /UnicodeEncodeError/);
      assert.ok(out.stdout.includes(`Triage: skill ${skillDir}`), out.stdout);
      assert.match(out.stdout, /^TRIAGE PASSED$/m);
    });
  }
});

describe("runTriage output encoding", () => {
  it("returns a readable verdict for a non-ASCII skill path when the parent env says ascii", async (t) => {
    // runTriage resolves ~/.claude/skills/triage at import, so it runs in a child with its own home.
    const home = join(root, "home");
    mkdirSync(home);
    const triageJs = new URL("./triage.js", import.meta.url).href;
    const script = `const m = await import(${JSON.stringify(triageJs)});
const r = await m.runTriage("skill", process.argv[1]);
process.stdout.write(JSON.stringify(r));`;
    let stdout: string;
    try {
      ({ stdout } = await exec(process.execPath, ["--input-type=module", "-e", script, skillDir], {
        env: { ...legacyEnv("ascii"), HOME: home, USERPROFILE: home },
        encoding: "utf8",
        timeout: 60_000,
      }));
    } catch (err) {
      assert.fail(`runTriage child failed:\n${(err as { stderr?: string }).stderr ?? ""}`);
    }
    const r = JSON.parse(stdout) as { passed: boolean; output: string };
    if (/python3|ENOENT/.test(r.output) && !r.output.includes("Triage:")) {
      t.skip("python3 not installed: runTriage's python path is NOT verified in this run");
      return;
    }
    assert.doesNotMatch(r.output, /UnicodeEncodeError/);
    assert.ok(r.output.includes(`Triage: skill ${skillDir}`), r.output);
    assert.equal(r.passed, true, r.output);
  });
});
