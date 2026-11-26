/**
 * kit#1082 lets a skill `name` hold Unicode lowercase letters and digits, as the agentskills.io
 * spec does. Every harness that loads a SKILL.md (Claude Code, Codex and others) lists the skill
 * by that name, so a name with a Cyrillic or Greek lookalike reads as another skill's ASCII name.
 * These run the real triage.py (skill_name.py) on neutral fixtures. Every rule is a warning.
 * Non-ASCII characters are written as escapes so this file stays ASCII.
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

type T = { skip: (m: string) => void; after(fn: () => void): void };

async function triage(target: string, t: T): Promise<string | null> {
  try {
    // The fixture's folder name is non-ASCII and triage.py prints the path it validated; a
    // Windows pipe defaults to a legacy code page. skill_name.py's own lines are ASCII-only.
    const env = { ...process.env, PYTHONIOENCODING: "utf-8" };
    return (await exec("python3", ["-I", TRIAGE_PY, "skill", target], { timeout: 30_000, env }))
      .stdout;
  } catch (err) {
    const e = err as { code?: string | number; stdout?: string };
    if (e.code === "ENOENT") {
      t.skip("python3 not installed: skill_name.py's behaviour is NOT verified in this run");
      return null;
    }
    return e.stdout ?? "";
  }
}

/** A skill directory `<tmp>/<folder>/SKILL.md` whose frontmatter `name` is `name`. */
function skill(t: T, folder: string, name: string): string {
  const root = mkdtempSync(join(tmpdir(), "kit-skill-name-"));
  t.after(() => rmTemp(root));
  const dir = join(root, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\n\nTake notes.\n`);
  return dir;
}

const failed = (out: string) => /^TRIAGE FAILED$/m.test(out);
const warnings = (out: string) => Number(/^Warnings: (\d+)$/m.exec(out)?.[1] ?? "0");

describe("skill triage: Unicode in the skill name", () => {
  it("passes an ASCII name with no warning", async (t) => {
    const out = await triage(skill(t, "notes", "notes"), t);
    if (out === null) return;
    assert.ok(!failed(out) && warnings(out) === 0, out);
  });

  it("warns that a Cyrillic lookalike name looks like its ASCII skeleton", async (t) => {
    const out = await triage(skill(t, "n\u043etes", "n\u043etes"), t);
    if (out === null) return;
    assert.ok(!failed(out), out);
    assert.match(out, /skill name 'n\\u043etes' looks like `notes`/);
    assert.match(out, /U\+043E CYRILLIC SMALL LETTER O/);
    assert.match(out, /Claude Code, Codex/);
  });

  it("maps Greek lookalikes too, and names every character", async (t) => {
    const out = await triage(skill(t, "x", "\u03c1\u03b1ge-t\u03bfol"), t);
    if (out === null) return;
    assert.ok(!failed(out), out);
    assert.match(out, /looks like `page-tool`/);
    for (const cp of ["U+03C1", "U+03B1", "U+03BF"]) assert.ok(out.includes(cp), cp);
  });

  it("warns plainly on a non-ASCII name that is not a lookalike", async (t) => {
    const out = await triage(skill(t, "x", "z\u00fcge"), t);
    if (out === null) return;
    assert.ok(!failed(out), out);
    assert.match(out, /characters outside ASCII: .*U\+00FC LATIN SMALL LETTER U WITH DIAERESIS/);
    assert.doesNotMatch(out, /looks like/);
  });

  it("applies to a plugin's skills", async (t) => {
    const dir = skill(t, "plugin", "unused");
    mkdirSync(join(dir, ".claude-plugin"));
    writeFileSync(join(dir, ".claude-plugin", "plugin.json"), '{"name":"p"}\n');
    mkdirSync(join(dir, "skills", "notes"), { recursive: true });
    const md = "---\nname: nоtes\ndescription: d\n---\n\nTake notes.\n";
    writeFileSync(join(dir, "skills", "notes", "SKILL.md"), md);
    const out = await triage(dir, t);
    if (out === null) return;
    assert.ok(!failed(out), out);
    assert.match(out, /skills\/notes\/SKILL\.md: skill name 'n\\u043etes' looks like `notes`/);
  });

  it("warns when the folder and the name differ only in normalisation", async (t) => {
    // NFC "caf\u00e9" in frontmatter, NFD "cafe\u0301" as the folder, as macOS may store it.
    const out = await triage(skill(t, "cafe\u0301", "caf\u00e9"), t);
    if (out === null) return;
    assert.ok(!failed(out), out);
    assert.match(out, /differ only in Unicode normalisation \(NFKC\)/);
  });
});
