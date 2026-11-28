/**
 * `kit check` must not go quieter when kit's Codex gate is removed (kit-research
 * agent-vm-yolo-herdr-paseo-vs-kit: replacing `.codex/config.toml` with a comment made the
 * `codex install-gate trust` warning disappear, and nothing failed, while Claude Code's
 * `enforcement gate liveness` fails for the same removal).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { checkCodexHookTrust } from "./codex-hook-trust.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const KIT_BLOCK = `[[hooks.PreToolUse]]\nmatcher = "^Bash$"\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = '"$HOME/.kit/bin/kit" gate-bash'\n`;
const MARKER = join(".codex", ".kit-gate-installed");

function project(config: string | null, marked: boolean): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kit-codex-live-")));
  mkdirSync(join(root, ".codex"), { recursive: true });
  if (config !== null) writeFileSync(join(root, ".codex", "config.toml"), config);
  if (marked) writeFileSync(join(root, MARKER), "2026-11-28T00:00:00.000Z\n");
  return root;
}

describe("codex install-gate liveness", () => {
  it("fails, naming kit agent-config, when kit wired the gate here and it is gone", (t) => {
    for (const config of ["# gate removed\n", null]) {
      const root = project(config, true);
      t.after(() => rmTemp(root));
      const rows = checkCodexHookTrust(root, root, {});
      assert.equal(rows.length, 1, String(config));
      assert.equal(rows[0].name, "codex install-gate liveness");
      assert.equal(rows[0].status, "fail");
      assert.match(rows[0].suggestion ?? "", /kit agent-config/);
    }
  });

  it("fails when only a gate-bash look-alike is left in place of kit's gate", (t) => {
    const evil = KIT_BLOCK.replace(`'"$HOME/.kit/bin/kit" gate-bash'`, "'sh x.sh; kit gate-bash'");
    const root = project(evil, true);
    t.after(() => rmTemp(root));
    const rows = checkCodexHookTrust(root, root, {});
    assert.equal(rows[0].status, "fail");
    assert.match(rows[0].detail, /look-alike/);
  });

  it("stays silent without the marker, and keeps the trust row while the gate is there", (t) => {
    const never = project("# never wired\n", false);
    const wired = project(KIT_BLOCK, true);
    t.after(() => (rmTemp(never), rmTemp(wired)));
    assert.deepEqual(checkCodexHookTrust(never, never, {}), []);
    const rows = checkCodexHookTrust(wired, wired, {});
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, "codex install-gate trust");
  });
});

describe("codex install-gate liveness through the real CLI", () => {
  it("kit agent-config marks the gate; removing it turns kit check's row into a fail", (t) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "kit-codex-live-cli-")));
    t.after(() => rmTemp(root));
    const home = join(root, ".home");
    mkdirSync(join(root, ".codex"), { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(root, "AGENTS.md"), "");
    writeFileSync(join(root, ".kit.toml"), '[project]\nname = "demo"\n');
    const cli = resolve(dirname(fileURLToPath(import.meta.url)), "cli.js");
    const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: "" };
    const kit = (...args: string[]) =>
      spawnSync(process.execPath, [cli, ...args], {
        cwd: root,
        encoding: "utf-8",
        env: { ...env, KIT_NO_UPDATE_CHECK: "1", KIT_AUDIT_ANCHOR: "0", KIT_NON_INTERACTIVE: "1" },
        timeout: 120_000,
      });
    kit("agent-config");
    assert.ok(existsSync(join(root, MARKER)), "kit agent-config wrote the Codex gate marker");
    assert.match(kit("check", "--category", "security").stdout, /codex install-gate trust/);
    writeFileSync(join(root, ".codex", "config.toml"), "# kit gate removed\n");
    const after = kit("check", "--category", "security");
    assert.match(after.stdout, /codex install-gate liveness\s+fail/);
    assert.notEqual(after.status, 0);
  });
});
