import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { trailCommandRefusal, trailWriteRefusal } from "./trail-guard.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const HOME = resolve(tmpdir(), "kit-trail-home");
const CWD = resolve(tmpdir(), "kit-trail-project");

describe("trail guard: shell commands that change kit's trail are refused", () => {
  for (const command of [
    "rm .kit-audit.jsonl",
    "truncate -s 0 .kit-audit.jsonl",
    "sed -i '2d' .kit-audit.jsonl",
    "echo '{}' > .kit-audit.jsonl",
    "printf x >> ./.kit-approvals.jsonl",
    "git status && rm -f .kit-approvals.jsonl",
    "sudo mv .kit-audit.jsonl /tmp/old",
    "Remove-Item .kit-audit.jsonl",
    "rm -rf ~/.kit",
    'cp evil "$HOME/.kit/elevation.key"',
    "cat ~/.kit/audit-anchor.key",
    "rm ~/.kit/audit-anchor.json",
    "kit audit anchor",
    '"$HOME/.kit/bin/kit" audit anchor',
    "kit panic --yes",
  ]) {
    it(command, () => {
      assert.ok(trailCommandRefusal(command, HOME), `expected a refusal for: ${command}`);
    });
  }
});

describe("trail guard: reading the trail and running kit stay allowed", () => {
  for (const command of [
    "cat .kit-audit.jsonl",
    "tail -n 5 .kit-audit.jsonl | jq .",
    "kit audit verify",
    '"$HOME/.kit/bin/kit" check',
    "ls ~/.kit/bin",
    "rm -rf dist",
    "git log --oneline",
  ]) {
    it(command, () => {
      assert.equal(trailCommandRefusal(command, HOME), null);
    });
  }
});

describe("trail guard: file writes", () => {
  it("refuses a write to the audit log or approvals in any directory", () => {
    assert.ok(trailWriteRefusal(".kit-audit.jsonl", CWD, HOME));
    assert.ok(trailWriteRefusal(join("sub", ".kit-approvals.jsonl"), CWD, HOME));
  });

  it("refuses a write under ~/.kit", () => {
    assert.ok(trailWriteRefusal(join(HOME, ".kit", "audit-anchor.json"), CWD, HOME));
  });

  it("allows other files, including a project's own .kit directory", () => {
    assert.equal(trailWriteRefusal("src/a.ts", CWD, HOME), null);
    assert.equal(trailWriteRefusal(join(".kit", "standards.d", "x.toml"), CWD, HOME), null);
    assert.equal(trailWriteRefusal(join(HOME, ".kitchen", "x"), CWD, HOME), null);
  });
});

describe("trail guard: the compiled gates refuse and audit", () => {
  const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "cli.js");

  function gate(name: string, payload: unknown, t: { after(fn: () => void): void }) {
    const dir = mkdtempSync(join(tmpdir(), "kit-trail-gate-"));
    t.after(() => rmTemp(dir));
    spawnSync("git", ["init", "-q", dir]);
    return spawnSync(process.execPath, [CLI, name], {
      cwd: dir,
      input: JSON.stringify(payload),
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: join(dir, ".home"),
        USERPROFILE: join(dir, ".home"),
        KIT_HIDE_HOOK_SKIP_BANNER: "1",
        KIT_AUDIT_ANCHOR: "0",
        KIT_NO_UPDATE_CHECK: "1",
      },
      timeout: 60_000,
    });
  }

  it("gate-bash refuses deleting the audit log", (t) => {
    const run = gate(
      "gate-bash",
      { tool_name: "Bash", tool_input: { command: "rm .kit-audit.jsonl" } },
      t,
    );
    assert.equal(run.status, 2, run.stderr);
    assert.match(run.stderr, /trail-guard/);
  });

  it("gate-env refuses a Write to the audit log", (t) => {
    const run = gate(
      "gate-env",
      { tool_name: "Write", tool_input: { file_path: ".kit-audit.jsonl", content: "{}\n" } },
      t,
    );
    assert.equal(run.status, 2, run.stderr);
    assert.match(run.stderr, /trail-guard/);
  });
});
