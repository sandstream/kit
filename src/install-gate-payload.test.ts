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
import { extractCommandFromHookPayload, extractCommandsFromHookPayload } from "./install-gate.js";
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
// `apps/vscode/src/sdk/hooks-adapter.ts:28-38,168-174` (VS Code parameters as JSON text),
// `sdk/packages/core/src/hooks/hook-file-hooks.ts:845-867` (CLI tool_call.input).
describe("Cline run_commands: every command, from every payload shape", () => {
  const vs = (parameters: Record<string, string>, toolName = "run_commands") => ({
    taskId: "t",
    preToolUse: { toolName, parameters },
  });
  it("reads the JSON-text commands list of the VS Code payload", () => {
    const p = vs({ commands: JSON.stringify(["ls", "npm i a"]) });
    assert.deepEqual(extractCommandsFromHookPayload(p), ["ls", "npm i a"]);
    assert.equal(extractCommandFromHookPayload(p), "ls\nnpm i a");
  });
  it("prefers the CLI's raw tool_call.input and joins structured argv", () => {
    const p = {
      tool_call: {
        name: "run_commands",
        input: { commands: ["ls", { command: "npm", args: ["i", "b"] }] },
      },
      preToolUse: { toolName: "run_commands", parameters: { commands: "ignored" } },
    };
    assert.deepEqual(clineCommands(p), ["ls", "npm i b"]);
  });
  it("keeps the legacy single command, cmd, and a bare string commands value", () => {
    assert.deepEqual(clineCommands(vs({ command: "npm i c" }, "execute_command")), ["npm i c"]);
    assert.deepEqual(clineCommands(vs({ cmd: "npm i d" })), ["npm i d"]);
    assert.deepEqual(clineCommands(vs({ commands: "npm i e" })), ["npm i e"]);
    assert.deepEqual(clineCommands(vs({ commands: "[ -f x ] && npm i f" })), [
      "[ -f x ] && npm i f",
    ]);
  });
  it("reads nothing from other tools, and marks an unreadable shell call", () => {
    assert.deepEqual(clineCommands(vs({ path: "a.ts", new_text: "x" }, "editor")), []);
    const patch = {
      tool_call: { name: "apply_patch", input: "*** Begin Patch" },
      preToolUse: { toolName: "apply_patch", parameters: {} },
    };
    assert.deepEqual(clineCommands(patch), []);
    assert.equal(clineShellCallUnreadable(patch), false);
    assert.equal(clineShellCallUnreadable(vs({})), true);
    assert.equal(clineShellCallUnreadable(vs({ commands: "[]" })), true);
    assert.equal(clineShellCallUnreadable(vs({ commands: JSON.stringify(["ls"]) })), false);
    assert.equal(clineCommands({ tool_input: { command: "x" } }), undefined, "not a Cline payload");
  });
});
