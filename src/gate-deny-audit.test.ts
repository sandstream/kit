/**
 * Every PreToolUse deny leaves an audit entry (design §3.3).
 *
 * kit-research gpt-6-astra-swarm-incident-vs-kit measured two gaps: `gate-bash` and `gate-env`
 * never audited a deny at all, and no gate audited one in a repository without a `.kit.toml`.
 * These tests drive the compiled CLI in a fresh repository with no `.kit.toml`. Both denies are
 * offline by construction: an unresolvable install and a plaintext secret write.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTemp } from "./temp-cleanup.test-support.js";

const CLI_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "cli.js");

function deny(gate: string, payload: unknown, t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "kit-deny-audit-"));
  t.after(() => rmTemp(dir));
  spawnSync("git", ["init", "-q", dir]);
  const run = spawnSync(process.execPath, [CLI_PATH, gate], {
    cwd: dir,
    input: JSON.stringify(payload),
    encoding: "utf-8",
    env: {
      ...process.env,
      HOME: join(dir, ".home"),
      KIT_HIDE_HOOK_SKIP_BANNER: "1",
      KIT_AUDIT_ANCHOR: "0",
      KIT_NO_UPDATE_CHECK: "1",
    },
    timeout: 60_000,
  });
  return { run, dir };
}

function auditRows(dir: string): Array<Record<string, unknown>> {
  const file = join(dir, ".kit-audit.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("a gate deny is audited, with or without a .kit.toml", () => {
  it("gate-bash", (t) => {
    const { run, dir } = deny(
      "gate-bash",
      {
        tool_name: "Bash",
        tool_input: { command: "npm --frobnicate thing install gate-fixture" },
        session_id: "s-bash",
      },
      t,
    );
    assert.equal(run.status, 2, run.stderr);
    const rows = auditRows(dir);
    assert.equal(rows.length, 1, JSON.stringify(rows));
    assert.equal(rows[0]!.operation, "gate-bash");
    assert.equal(rows[0]!.success, false);
    assert.deepEqual(rows[0]!.metadata, { phase: "pretooluse-deny", session_id: "s-bash" });
  });

  it("gate-env", (t) => {
    const { run, dir } = deny(
      "gate-env",
      {
        tool_name: "Write",
        tool_input: {
          file_path: ".env",
          content: "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n", // AWS's documented example key
        },
      },
      t,
    );
    assert.equal(run.status, 2, run.stderr);
    const rows = auditRows(dir);
    assert.equal(rows.length, 1, JSON.stringify(rows));
    assert.equal(rows[0]!.operation, "gate-env");
  });
});
