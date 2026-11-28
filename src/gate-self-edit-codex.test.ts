/**
 * gate-self-edit guards Codex's hook config, not only Claude Code's settings (kit-research
 * agent-vm-yolo-herdr-paseo-vs-kit: after `kit agent-config`, `sed -i '/gate-bash/d'
 * .codex/config.toml` and a Write to it passed the gates with exit 0).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { gateSettingsCommandRefusal, gateSettingsWriteRefusal } from "./gate-self-edit.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const CWD = resolve("/w");
const HOME = resolve("/h");
const CONFIG = resolve(CWD, ".codex", "config.toml");
const USER_HOOKS = join(HOME, ".codex", "hooks.json");
const GATE = '"$HOME/.kit/bin/kit" gate-bash';
const TOML = `model = "o3"\n\n[[hooks.PreToolUse]]\nmatcher = "^Bash$"\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = '${GATE}'\n`;
const JSON_HOOKS = JSON.stringify({
  hooks: { PreToolUse: [{ matcher: "^Bash$", hooks: [{ type: "command", command: GATE }] }] },
});
const reader = (files: Record<string, string>) => (p: string) => files[p] ?? null;
const write = (
  tool_input: Record<string, unknown>,
  files: Record<string, string>,
  codexHome?: string,
) =>
  gateSettingsWriteRefusal({ tool_name: "Edit", tool_input }, CWD, HOME, reader(files), codexHome);

describe("gate-self-edit: writes to Codex hook config", () => {
  it("refuses a Write that drops kit's gate from .codex/config.toml", () => {
    const r = write({ file_path: CONFIG, content: "# nothing\n" }, { [CONFIG]: TOML });
    assert.match(r ?? "", /remove or change kit's gate hook in \.codex\/config\.toml/);
  });

  it("refuses an Edit that changes the gate's matcher", () => {
    const edit = { file_path: CONFIG, old_string: '"^Bash$"', new_string: '"^Nothing$"' };
    assert.match(write(edit, { [CONFIG]: TOML }) ?? "", /remove or change kit's gate hook/);
  });

  it("refuses a result that does not parse, and an edit it cannot compute", () => {
    const broken = write({ file_path: CONFIG, content: "[[hooks" }, { [CONFIG]: TOML });
    assert.match(broken ?? "", /unparseable/);
    const unknown = { file_path: CONFIG, old_string: "absent", new_string: "x" };
    assert.match(write(unknown, { [CONFIG]: TOML }) ?? "", /cannot be checked/);
  });

  it("allows an edit that keeps the gate, and any write where no gate is wired", () => {
    const edit = { file_path: CONFIG, old_string: 'model = "o3"', new_string: 'model = "o4"' };
    assert.equal(write(edit, { [CONFIG]: TOML }), null);
    assert.equal(write({ file_path: CONFIG, content: "" }, { [CONFIG]: 'model = "o3"' }), null);
  });

  it("guards the user hooks.json in ~/.codex and in $CODEX_HOME", () => {
    const drop = { file_path: USER_HOOKS, content: "{}" };
    assert.match(write(drop, { [USER_HOOKS]: JSON_HOOKS }) ?? "", /\.codex\/hooks\.json/);
    const custom = resolve("/ch");
    const file = join(custom, "config.toml");
    const r = write({ file_path: file, content: "" }, { [file]: TOML }, custom);
    assert.match(r ?? "", /remove or change kit's gate hook/);
  });
});

describe("gate-self-edit: shell writes onto Codex hook config", () => {
  const files = { [CONFIG]: TOML };
  const bash = (command: string, f: Record<string, string> = files, codexHome?: string) =>
    gateSettingsCommandRefusal(command, CWD, HOME, reader(f), codexHome);

  it("refuses sed, rm and a redirect onto .codex/config.toml (the measured exit 0)", () => {
    for (const command of [
      "sed -i '/gate-bash/d' .codex/config.toml",
      "rm .codex/config.toml",
      "printf x > .codex/config.toml",
    ]) {
      assert.match(bash(command) ?? "", /Codex hook config file/, command);
    }
  });

  it("refuses a write onto the user hooks.json, named by $HOME or $CODEX_HOME", () => {
    const user = { [USER_HOOKS]: JSON_HOOKS };
    assert.match(bash("sed -i '/gate-bash/d' $HOME/.codex/hooks.json", user) ?? "", /Codex hook/);
    const custom = resolve("/ch");
    const at = { [join(custom, "hooks.json")]: JSON_HOOKS };
    assert.match(bash('rm "$CODEX_HOME/hooks.json"', at, custom) ?? "", /Codex hook/);
  });

  it("allows reading the file, and any write when no Codex file holds the gate", () => {
    assert.equal(bash("cat .codex/config.toml"), null);
    assert.equal(bash("rm .codex/config.toml", { [CONFIG]: 'model = "o3"' }), null);
  });
});

describe("the gates refuse Codex unwiring through the real CLI (exit 0 before)", () => {
  it("gate-bash and gate-env exit 2 on the removal, 0 on an unrelated edit", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "kit-self-edit-codex-"));
    t.after(() => rmTemp(dir));
    const home = join(dir, ".home");
    mkdirSync(join(dir, ".codex"), { recursive: true });
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(dir, ".codex", "config.toml"), TOML);
    writeFileSync(join(home, ".codex", "hooks.json"), JSON_HOOKS);
    const cli = resolve(dirname(fileURLToPath(import.meta.url)), "cli.js");
    const env = { ...process.env, HOME: home, USERPROFILE: home, KIT_NO_UPDATE_CHECK: "1" };
    const run = (gate: string, tool_name: string, tool_input: Record<string, unknown>) =>
      spawnSync(process.execPath, [cli, gate], {
        cwd: dir,
        input: JSON.stringify({ tool_name, tool_input }),
        encoding: "utf-8",
        env: { ...env, KIT_AUDIT_ANCHOR: "0", KIT_HIDE_HOOK_SKIP_BANNER: "1", CODEX_HOME: "" },
        timeout: 60_000,
      });
    for (const command of [
      "sed -i '/gate-bash/d' .codex/config.toml",
      "rm .codex/config.toml",
      "printf x > .codex/config.toml",
      "sed -i '/gate-bash/d' $HOME/.codex/hooks.json",
    ]) {
      const r = run("gate-bash", "Bash", { command });
      assert.equal(r.status, 2, `${command}: ${r.stderr}`);
    }
    const drop = run("gate-env", "Write", { file_path: ".codex/config.toml", content: "# x\n" });
    assert.equal(drop.status, 2, drop.stderr);
    assert.match(drop.stderr, /kit's gate hook in \.codex\/config\.toml/);
    const keep = { file_path: ".codex/config.toml", old_string: 'model = "o3"', new_string: "" };
    assert.equal(run("gate-env", "Edit", keep).status, 0);
  });
});
