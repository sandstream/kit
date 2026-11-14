import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { toolArgsCommand } from "./install-gate-payload.js";
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
  it("denies on stdout with exit 0, and allows on stdout", () => {
    const toolCall = (command: string) => ({
      toolCall: { name: "run_command", args: { CommandLine: command } },
    });
    const denied = gate(toolCall(BLOCKED), ["--format", "antigravity"]);
    assert.equal(denied.status, 0, denied.stderr);
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
    const groups = JSON.parse(readFileSync(join(dir, ".agents", "hooks.json"), "utf8")).hooks
      .PreToolUse;
    assert.equal(groups.length, 1);
    assert.ok(groups[0].hooks[0].command.endsWith("gate-bash --format antigravity"));
    assert.equal((await installInstallGateAntigravity(dir)).action, "unchanged");
  });
});
