/**
 * `kit audit anchor` must not erase the alarm `kit audit verify` raises.
 *
 * kit-research `agent-swarms-security-guide-vs-kit` measured that after a row was dropped from an
 * anchored log, `kit audit anchor` re-sealed the shorter log without a word and `verify` went
 * green. These tests drive the compiled CLI with an isolated HOME and anchor directory.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTemp } from "./temp-cleanup.test-support.js";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "cli.js");

function project(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "kit-reseal-"));
  t.after(() => rmTemp(dir));
  spawnSync("git", ["init", "-q", dir]);
  const env = {
    ...process.env,
    HOME: join(dir, ".home"),
    USERPROFILE: join(dir, ".home"),
    KIT_AUDIT_ANCHOR_DIR: join(dir, ".anchors"),
    KIT_HIDE_HOOK_SKIP_BANNER: "1",
    KIT_NO_UPDATE_CHECK: "1",
  };
  const kit = (args: string[], input = "") =>
    spawnSync(process.execPath, [CLI, ...args], {
      cwd: dir,
      env,
      input,
      encoding: "utf-8",
      timeout: 60_000,
    });
  // Three audit rows, each from a gate-fs deny (no signed scope), then a seal.
  for (const name of ["a", "b", "c"]) {
    kit(
      ["gate-fs"],
      JSON.stringify({
        tool_name: "Write",
        tool_input: { file_path: `${name}.txt`, content: "x" },
      }),
    );
  }
  const log = join(dir, ".kit-audit.jsonl");
  return { kit, log };
}

function dropLastRow(log: string): void {
  const rows = readFileSync(log, "utf8").trimEnd().split("\n");
  writeFileSync(log, rows.slice(0, -1).join("\n") + "\n");
}

describe("kit audit anchor over a rolled-back log", () => {
  it("refuses to re-seal, and verify still fails", (t) => {
    const { kit, log } = project(t);
    assert.equal(kit(["audit", "anchor"]).status, 0);
    dropLastRow(log);
    const reseal = kit(["audit", "anchor"]);
    assert.notEqual(reseal.status, 0, reseal.stdout);
    assert.match(reseal.stderr, /refusing to re-seal/);
    assert.notEqual(kit(["audit", "verify"]).status, 0);
  });

  it("re-seals with --accept-rollback, a person's explicit choice", (t) => {
    const { kit, log } = project(t);
    assert.equal(kit(["audit", "anchor"]).status, 0);
    dropLastRow(log);
    assert.equal(kit(["audit", "anchor", "--accept-rollback"]).status, 0);
    assert.equal(kit(["audit", "verify"]).status, 0);
  });

  it("still extends an intact anchored log", (t) => {
    const { kit } = project(t);
    assert.equal(kit(["audit", "anchor"]).status, 0);
    assert.equal(kit(["audit", "anchor"]).status, 0);
  });
});
