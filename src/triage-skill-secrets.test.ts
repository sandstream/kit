/**
 * `kit triage skill <dir>` secret scan. It once matched bare substrings, so "ask-first" failed a
 * real skill CRITICAL for `sk-`, and it read only SKILL.md, so a skill's scripts were never
 * opened. Both are pinned here against the script itself.
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
const FRONTMATTER = "---\nname: probe\ndescription: A probe skill.\n---\n\n";

/** Builds a skill directory and triages it; null when python3 is absent (skipped loudly). */
async function triageSkill(
  t: { after(fn: () => void): void; skip(m: string): void },
  files: Record<string, string | Buffer>,
): Promise<string | null> {
  const dir = mkdtempSync(join(tmpdir(), "kit-triage-skill-"));
  t.after(() => rmTemp(dir));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  try {
    return (await exec("python3", ["-I", TRIAGE_PY, "skill", dir], { timeout: 30_000 })).stdout;
  } catch (err) {
    const e = err as { code?: string | number; stdout?: string };
    if (e.code === "ENOENT") {
      t.skip("python3 not installed — triage.py's own behaviour is NOT verified in this run");
      return null;
    }
    return e.stdout ?? "";
  }
}

describe("kit triage skill: secret scan", () => {
  it("does not take words like ask-first, task- or risk- for a key", async (t) => {
    const out = await triageSkill(t, {
      "SKILL.md": `${FRONTMATTER}Skip ask-first rules for tests. Run the task-runner. A risk-based tier.\n`,
    });
    if (out === null) return;
    assert.doesNotMatch(out, /CRITICAL/, out);
    assert.match(out, /TRIAGE PASSED/);
  });

  it("still fails a real-shaped key in SKILL.md", async (t) => {
    const out = await triageSkill(t, {
      "SKILL.md": `${FRONTMATTER}export OPENAI_API_KEY=sk-${"A1".repeat(24)}\n`,
    });
    if (out === null) return;
    assert.match(out, /CRITICAL: possible secret in skill body: api key \(sk-\)/);
    assert.match(out, /TRIAGE FAILED/);
  });

  it("reads the skill's scripts, not only SKILL.md", async (t) => {
    const out = await triageSkill(t, {
      "SKILL.md": `${FRONTMATTER}Run scripts/setup.sh.\n`,
      "scripts/setup.sh": `#!/bin/sh\nexport TOKEN=ghp_${"B".repeat(36)}\n`,
    });
    if (out === null) return;
    assert.match(out, /possible secret in scripts\/setup\.sh: GitHub token/);
    assert.match(out, /scanned 1 other file\(s\)/);
  });

  it("names a file it could not read instead of passing over it", async (t) => {
    const out = await triageSkill(t, {
      "SKILL.md": `${FRONTMATTER}Body.\n`,
      "assets/blob.bin": Buffer.from([0xff, 0xfe, 0x00, 0x80]),
    });
    if (out === null) return;
    assert.match(out, /not scanned \(binary, symlink or over 1 MB\): assets\/blob\.bin/);
  });
});
