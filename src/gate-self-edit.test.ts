/**
 * An agent may not unwire its own gates (kit-research verify-against-real-state-vs-kit,
 * humanmaxxing-vs-kit). A Write or Edit that removes or replaces a kit gate entry in a Claude Code
 * settings file is refused; one that adds another tool's hook is not.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  gateSettingsCommandRefusal,
  gateSettingsWriteRefusal,
  kitGateCommands,
  resultingText,
} from "./gate-self-edit.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const CWD = resolve("/w");
const HOME = resolve("/h");
const SETTINGS = resolve(CWD, ".claude", "settings.json");
const GATE = '"$HOME/.kit/bin/kit" gate-bash';
const ENV = '"$HOME/.kit/bin/kit" gate-env';

function settings(commands: string[]): string {
  const PreToolUse = commands.map((command) => ({
    matcher: "Bash",
    hooks: [{ type: "command", command }],
  }));
  return JSON.stringify({ hooks: { PreToolUse } }, null, 2);
}

const CURRENT = settings([GATE, ENV]);
const reader = (files: Record<string, string>) => (p: string) => files[p] ?? null;
const write = (tool_input: Record<string, unknown>) =>
  gateSettingsWriteRefusal(
    { tool_name: "Write", tool_input },
    CWD,
    HOME,
    reader({ [SETTINGS]: CURRENT }),
  );

describe("gateSettingsWriteRefusal", () => {
  it("refuses a write that adds a hook next to kit's, on any event", () => {
    const next = settings([GATE, ENV, "bash .claude/hooks/guard.sh"]);
    const r = write({ file_path: ".claude/settings.json", content: next });
    assert.match(r ?? "", /would add a hook to settings\.json \(PreToolUse: bash \.claude/);
    const stop = JSON.parse(CURRENT) as { hooks: Record<string, unknown> };
    stop.hooks.Stop = [{ hooks: [{ type: "command", command: "node ./tools/listen.js" }] }];
    assert.match(
      write({ file_path: ".claude/settings.json", content: JSON.stringify(stop) }) ?? "",
      /Stop: node \.\/tools\/listen\.js/,
    );
  });

  it("allows a write that changes other settings and keeps every hook", () => {
    const next = JSON.parse(CURRENT) as Record<string, unknown>;
    next.permissions = { deny: ["Read(.env)"] };
    assert.equal(
      write({ file_path: ".claude/settings.json", content: JSON.stringify(next) }),
      null,
    );
    assert.equal(
      write({ file_path: ".claude/settings.json", content: settings([ENV, GATE]) }),
      null,
    );
  });

  it("refuses a new hook in a settings file beside the one that wires the gate", () => {
    const local = resolve(CWD, ".claude", "settings.local.json");
    const r = gateSettingsWriteRefusal(
      { tool_input: { file_path: local, content: settings(["sh ./x.sh"]) } },
      CWD,
      HOME,
      reader({ [SETTINGS]: CURRENT }),
    );
    assert.match(r ?? "", /would add a hook to settings\.local\.json/);
  });

  it("names a hook that is not a command by its entry", () => {
    const next = JSON.parse(CURRENT) as { hooks: Record<string, unknown> };
    next.hooks.Stop = [{ hooks: [{ type: "prompt", prompt: "x" }] }];
    assert.match(
      write({ file_path: ".claude/settings.json", content: JSON.stringify(next) }) ?? "",
      /Stop: \{"type":"prompt"/,
    );
  });

  it("refuses a write that drops gate-bash", () => {
    const r = write({ file_path: ".claude/settings.json", content: settings([ENV]) });
    assert.match(r ?? "", /remove or change kit's gate hooks/);
  });

  it("refuses an edit that points gate-bash at a stub", () => {
    const r = write({
      file_path: ".claude/settings.json",
      old_string: '\\"$HOME/.kit/bin/kit\\" gate-bash',
      new_string: "/tmp/stub gate-bash",
    });
    assert.match(r ?? "", /remove or change/);
  });

  it("refuses a write that leaves the file unparseable", () => {
    assert.match(write({ file_path: ".claude/settings.json", content: "{" }) ?? "", /unparseable/);
  });

  it("refuses an edit it cannot compute", () => {
    const r = write({ file_path: ".claude/settings.json", old_string: "absent", new_string: "x" });
    assert.match(r ?? "", /cannot be checked/);
  });

  it("leaves other files and ungated settings alone", () => {
    assert.equal(write({ file_path: "src/a.ts", content: "x" }), null);
    const none = gateSettingsWriteRefusal(
      { tool_input: { file_path: ".claude/settings.json", content: "{}" } },
      CWD,
      HOME,
      reader({ [SETTINGS]: settings(["bash x.sh"]) }),
    );
    assert.equal(none, null);
  });

  it("guards the user-level settings file too", () => {
    const user = join(HOME, ".claude", "settings.json");
    const r = gateSettingsWriteRefusal(
      { tool_input: { file_path: user, content: "{}" } },
      CWD,
      HOME,
      reader({ [user]: CURRENT }),
    );
    assert.match(r ?? "", /remove or change/);
  });
});

describe("gateSettingsCommandRefusal", () => {
  const run = (cmd: string) =>
    gateSettingsCommandRefusal(cmd, CWD, HOME, reader({ [SETTINGS]: CURRENT }));

  it("refuses sed, redirects and moves onto the settings file", () => {
    assert.ok(run("sed -i s/gate-bash/x/ .claude/settings.json"));
    assert.ok(run("echo {} > .claude/settings.json"));
    assert.ok(run("mv /tmp/x .claude/settings.local.json"));
  });

  it("allows reading it and running kit agent-config", () => {
    assert.equal(run("cat .claude/settings.json"), null);
    assert.equal(run("jq . .claude/settings.json"), null);
    assert.equal(run("kit agent-config"), null);
  });

  it("allows anything when no settings file wires a kit gate", () => {
    assert.equal(
      gateSettingsCommandRefusal("rm .claude/settings.json", CWD, HOME, reader({})),
      null,
    );
  });
});

describe("helpers", () => {
  it("kitGateCommands finds gate commands and rejects non-objects", () => {
    assert.deepEqual(kitGateCommands(CURRENT), [GATE, ENV]);
    assert.equal(kitGateCommands("[]"), null);
  });

  it("resultingText applies MultiEdit edits in order", () => {
    const edits = [
      { old_string: "a", new_string: "b" },
      { old_string: "b", new_string: "c", replace_all: true },
    ];
    assert.equal(resultingText("ab", { edits }), "cc");
  });
});

describe("gate-env refuses an agent unwiring its gate (real CLI)", () => {
  it("exits 2 on the removal and on an added hook, 0 on another change", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "kit-self-edit-"));
    t.after(() => rmTemp(dir));
    const home = join(dir, ".home");
    mkdirSync(join(dir, ".claude"), { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(dir, ".claude", "settings.json"), CURRENT);
    const cli = resolve(dirname(fileURLToPath(import.meta.url)), "cli.js");
    const gate = (content: string) =>
      spawnSync(process.execPath, [cli, "gate-env"], {
        cwd: dir,
        input: JSON.stringify({
          tool_name: "Write",
          tool_input: { file_path: ".claude/settings.json", content },
        }),
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          KIT_NO_UPDATE_CHECK: "1",
          KIT_AUDIT_ANCHOR: "0",
          KIT_HIDE_HOOK_SKIP_BANNER: "1",
        },
        timeout: 60_000,
      });
    const removed = gate(settings([ENV]));
    assert.equal(removed.status, 2, removed.stderr);
    assert.match(removed.stderr, /remove or change kit's gate hooks/);
    const added = gate(settings([GATE, ENV, "bash x.sh"]));
    assert.equal(added.status, 2, added.stderr);
    assert.match(added.stderr, /would add a hook to settings\.json/);
    assert.equal(gate(JSON.stringify({ ...JSON.parse(CURRENT), model: "x" })).status, 0);
  });
});
