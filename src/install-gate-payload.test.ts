import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  clineCommands,
  clineShellCallUnreadable,
  toolArgsCommand,
} from "./install-gate-payload.js";
import { extractCommandFromHookPayload } from "./install-gate.js";
import { installInstallGateAntigravity } from "./agent-config.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const cli = join(dirname(fileURLToPath(import.meta.url)), "cli.js");
// Refused without a network call: the argument is not a package name kit can triage.
const BLOCKED = "npm install https://example.invalid/x.tgz";

function gate(payload: unknown, args: string[] = []) {
  return spawnSync(process.execPath, [cli, "gate-bash", ...args], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, KIT_OFFLINE: "1" },
  });
}

describe("Copilot CLI's camelCase toolArgs", () => {
  it("reads the command from an object or a JSON string, and nothing else", () => {
    assert.equal(toolArgsCommand({ toolArgs: { command: "npm i a" } }), "npm i a");
    assert.equal(toolArgsCommand({ toolArgs: JSON.stringify({ command: "npm i b" }) }), "npm i b");
    assert.equal(toolArgsCommand({ toolArgs: "not json" }), undefined);
    assert.equal(toolArgsCommand({ toolArgs: "null" }), undefined);
    assert.equal(toolArgsCommand(null), undefined);
    const payload = { toolName: "bash", toolArgs: JSON.stringify({ command: "npm i c" }) };
    assert.equal(extractCommandFromHookPayload(payload), "npm i c");
  });

  it("blocks an install carried in toolArgs with exit 2", () => {
    const r = gate({ toolName: "bash", toolArgs: JSON.stringify({ command: BLOCKED }) });
    assert.equal(r.status, 2, r.stdout + r.stderr);
  });
});

describe("--format antigravity: the required stdout decision", () => {
  it("denies on stdout and with exit 2, and allows on stdout", () => {
    const toolCall = (command: string) => ({
      toolCall: { name: "run_command", args: { CommandLine: command } },
    });
    const denied = gate(toolCall(BLOCKED), ["--format", "antigravity"]);
    // Antigravity documents no exit-code meaning, so the deny is on stdout and in the exit code.
    assert.equal(denied.status, 2, denied.stderr);
    const verdict = JSON.parse(denied.stdout.trim().split("\n").pop() ?? "{}");
    assert.equal(verdict.decision, "deny");
    assert.match(verdict.reason, /kit install-gate/);
    const allowed = gate(toolCall("ls -la"), ["--format", "antigravity"]);
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.deepEqual(JSON.parse(allowed.stdout.trim().split("\n").pop() ?? "{}"), {
      decision: "allow",
    });
  });

  it("upgrades an install written before the format, without a second hook", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "kit-antigrav-up-"));
    t.after(() => rmTemp(dir));
    mkdirSync(join(dir, ".agents"));
    const old = {
      hooks: {
        PreToolUse: [
          {
            matcher: "run_command",
            hooks: [{ type: "command", command: '"$HOME/.kit/bin/kit" gate-bash' }],
          },
        ],
      },
    };
    writeFileSync(join(dir, ".agents", "hooks.json"), JSON.stringify(old));
    assert.equal((await installInstallGateAntigravity(dir)).action, "updated");
    const written = JSON.parse(readFileSync(join(dir, ".agents", "hooks.json"), "utf8"));
    assert.equal(written.hooks, undefined, "kit's old entry is gone");
    const groups = written["kit-install-gate"].PreToolUse;
    assert.equal(groups.length, 1);
    assert.ok(groups[0].hooks[0].command.endsWith("gate-bash --format antigravity"));
    assert.equal((await installInstallGateAntigravity(dir)).action, "unchanged");
  });
});

// Cline run_commands shapes: github.com/cline/cline at cbc7d141, `schemas.ts:133-176` (input),
// `apps/vscode/src/sdk/hooks-adapter.ts:28-38,168-174` (VS Code parameters as JSON text).
describe("Cline run_commands: every command, each argv word quoted", () => {
  const vs = (parameters: Record<string, string>, toolName = "run_commands") => ({
    preToolUse: { toolName, parameters },
  });
  it("reads every shape, and quotes structured argv as shell words", () => {
    const cases: [unknown, string[] | undefined][] = [
      [vs({ commands: JSON.stringify(["ls", "npm i a"]) }), ["ls", "npm i a"]],
      [vs({ commands: "[ -f x ] && npm i f" }), ["[ -f x ] && npm i f"]],
      [vs({ command: "npm i c" }, "execute_command"), ["npm i c"]],
      [vs({ cmd: "npm i d" }), ["npm i d"]],
      [
        vs({ command: "echo", args: JSON.stringify(["a b", "it's", "; x"]) }),
        ["echo 'a b' 'it'\\''s' '; x'"],
      ],
      [vs({ path: "a.ts", new_text: "x" }, "editor"), []],
      [{ tool_input: { command: "x" } }, undefined],
    ];
    for (const [payload, want] of cases) assert.deepEqual(clineCommands(payload), want);
    assert.equal(extractCommandFromHookPayload(cases[0][0]), "ls\nnpm i a");
    assert.equal(clineShellCallUnreadable(vs({ commands: "[]" })), true);
    assert.equal(clineShellCallUnreadable(vs({ command: "npm", args: "i x" })), true);
    assert.equal(clineShellCallUnreadable(vs({ commands: JSON.stringify(["ls"]) })), false);
  });
});
