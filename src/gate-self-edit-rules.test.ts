/**
 * gate-self-edit protects kit's deny rules and Codex rules files, not only hooks
 * (kit-research prismor-always-allowed-rules-vs-kit, Measurement §2).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { KIT_DENY_RULES } from "./agent-config-strict.js";
import { gateSettingsCommandRefusal, gateSettingsWriteRefusal } from "./gate-self-edit.js";
import { codexAllowRules, isCodexRulesPath } from "./gate-self-edit-rules.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const CWD = resolve("/w");
const HOME = resolve("/h");
const SETTINGS = resolve(CWD, ".claude", "settings.json");
const LOCAL = resolve(CWD, ".claude", "settings.local.json");
const CODEX = join(HOME, ".codex", "rules", "default.rules");
const STRICT = JSON.stringify({ permissions: { deny: KIT_DENY_RULES } }, null, 2);
const reader = (files: Record<string, string>) => (p: string) => files[p] ?? null;
const write = (tool_input: Record<string, unknown>, files: Record<string, string>) =>
  gateSettingsWriteRefusal({ tool_name: "Edit", tool_input }, CWD, HOME, reader(files), undefined);

describe("gate-self-edit: kit's deny rules", () => {
  it("refuses an Edit that deletes a kit deny rule (the measured exit 0)", () => {
    const r = write(
      { file_path: SETTINGS, old_string: '"Read(~/.aws/**)",', new_string: "" },
      { [SETTINGS]: STRICT },
    );
    assert.match(r ?? "", /remove kit's deny rule\(s\) Read\(~\/\.aws\/\*\*\) from settings\.json/);
  });

  it("refuses an allow that matches a kit deny rule, in settings.local.json too", () => {
    const content = JSON.stringify({ permissions: { allow: ["Bash(git push:*)"] } });
    const r = write({ file_path: LOCAL, content }, {});
    assert.match(r ?? "", /add the allow rule Bash\(git push:\*\) to settings\.local\.json/);
    const user = join(HOME, ".claude", "settings.json");
    const ssh = JSON.stringify({ permissions: { allow: ["Read(~/.ssh/**)"] } });
    assert.match(write({ file_path: user, content: ssh }, {}) ?? "", /Read\(~\/\.ssh\/\*\*\)/);
  });

  it("allows other allows, reordering, an allow already there, and adding deny rules", () => {
    const next = JSON.parse(STRICT) as { permissions: { deny: string[]; allow?: string[] } };
    next.permissions.allow = ["Bash(npm test)", "Read(src/**)"];
    next.permissions.deny = [...next.permissions.deny].reverse().concat("Bash(curl *)");
    const files = { [SETTINGS]: STRICT };
    assert.equal(write({ file_path: SETTINGS, content: JSON.stringify(next) }, files), null);
    const had = JSON.stringify({ permissions: { allow: ["Bash(git push:*)"] } });
    const kept = JSON.stringify({ permissions: { allow: ["Bash(git push:*)", "Bash(ls)"] } });
    assert.equal(write({ file_path: LOCAL, content: kept }, { [LOCAL]: had }), null);
  });

  it("refuses an unparseable result or an edit it cannot compute where kit rules are held", () => {
    const files = { [SETTINGS]: STRICT };
    assert.match(write({ file_path: SETTINGS, content: "{" }, files) ?? "", /unparseable/);
    const r = write({ file_path: SETTINGS, old_string: "absent", new_string: "" }, files);
    assert.match(r ?? "", /cannot be checked against kit's deny rules/);
  });

  it("refuses a shell write to a settings file that holds only kit deny rules", () => {
    const run = (cmd: string) =>
      gateSettingsCommandRefusal(cmd, CWD, HOME, reader({ [SETTINGS]: STRICT }));
    assert.match(run("sed -i /aws/d .claude/settings.json") ?? "", /gate hooks or deny rules/);
    assert.equal(run("cat .claude/settings.json"), null);
  });
});

describe("gate-self-edit: Codex rules files", () => {
  const rule = 'prefix_rule(pattern=["git", "push"], decision="allow")';

  it("knows project, user and CODEX_HOME rules files", () => {
    assert.ok(isCodexRulesPath(CODEX, undefined));
    assert.ok(isCodexRulesPath(resolve(CWD, ".codex", "rules", "x.rules"), undefined));
    assert.ok(isCodexRulesPath(resolve("/c", "rules", "a.rules"), resolve("/c")));
    assert.equal(isCodexRulesPath(resolve(CWD, "firestore.rules"), undefined), false);
  });

  it("counts allow and decision-less prefix_rule calls, not prompt or forbidden", () => {
    const text = `${rule}\nprefix_rule(pattern = ["ls"])\nprefix_rule(pattern=["rm"], decision="forbidden")\nprefix_rule(pattern=["x)"], decision="prompt")`;
    assert.deepEqual(codexAllowRules(text), [rule, 'prefix_rule(pattern = ["ls"])']);
  });

  it("refuses a Write that adds an allow rule, allows one that adds a forbidden rule", () => {
    const r = write({ file_path: CODEX, content: rule }, {});
    assert.match(r ?? "", /add an allow rule to default\.rules \(prefix_rule/);
    const forbid = 'prefix_rule(pattern=["rm"], decision="forbidden")';
    assert.equal(
      write({ file_path: CODEX, content: `${rule}\n${forbid}` }, { [CODEX]: rule }),
      null,
    );
    const r2 = write({ file_path: CODEX, old_string: "nope", new_string: "" }, { [CODEX]: rule });
    assert.match(r2 ?? "", /cannot be checked/);
  });

  it("refuses shell writes onto a rules file and allows reading one", () => {
    const run = (cmd: string) => gateSettingsCommandRefusal(cmd, CWD, HOME, reader({}));
    assert.ok(run(`echo '${rule}' >> ~/.codex/rules/default.rules`));
    assert.ok(run("tee -a .codex/rules/default.rules < x"));
    assert.ok(run('cp /tmp/r "$CODEX_HOME/rules/default.rules"'));
    assert.ok(run("sed -i s/forbidden/allow/ ~/.codex/rules/default.rules"));
    assert.equal(run("cat ~/.codex/rules/default.rules"), null);
    assert.equal(run("sed -i s/a/b/ firestore.rules"), null);
  });
});

describe("the gates refuse it through the real CLI (measured exit 0 before)", () => {
  it("gate-env refuses the deny-rule Edit; gate-bash refuses the Codex append", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "kit-self-edit-rules-"));
    t.after(() => rmTemp(dir));
    const home = join(dir, ".home");
    mkdirSync(join(dir, ".claude"), { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(dir, ".claude", "settings.json"), STRICT);
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
    const edit = run("gate-env", "Edit", {
      file_path: ".claude/settings.json",
      old_string: '"Read(~/.aws/**)",',
      new_string: "",
    });
    assert.equal(edit.status, 2, edit.stderr);
    assert.match(edit.stderr, /remove kit's deny rule/);
    const command = `echo 'prefix_rule(pattern=["git","push"], decision="allow")' >> ~/.codex/rules/default.rules`;
    const bash = run("gate-bash", "Bash", { command });
    assert.equal(bash.status, 2, bash.stderr);
    assert.match(bash.stderr, /Codex rules file/);
  });
});
