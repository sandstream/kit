/**
 * MCP tools that start or steer another agent (kit-research#241: T3 Code's `delegate_task`,
 * `t3_thread_launch`, …). kit's matchers were `Bash|PowerShell` and `Write|Edit|NotebookEdit`, so
 * such a call reached no gate, and `gate-bash` let a payload with no shell command through. Tool
 * names from pingdotgg/t3code 0.1.13 (read as data); payload shape `mcp__<server>__<tool>` as Claude
 * Code and Codex send it (openai/codex `codex-rs/core/src/tools/handlers/mcp.rs`
 * `pre_tool_use_payload`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";

import { installInstallGate, installInstallGateCodex } from "./agent-config.js";
import { checkCodexHookTrust, codexGateHooks } from "./codex-hook-trust.js";
import { matcherSelects } from "./gate-bash-matcher.js";
import {
  ORCHESTRATION_MCP_MATCHER,
  orchestrationLaunch,
  orchestrationRefusal,
} from "./orchestration-mcp-tools.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "cli.js");
const call = (tool: string, input: unknown = {}) => ({ tool_name: tool, tool_input: input });

const LAUNCHES = [
  "mcp__t3__delegate_task",
  "mcp__t3__t3_thread_launch",
  "mcp__t3__t3_thread_send",
  "mcp__t3__t3_thread_send_attachments",
  "mcp__t3__create_threads",
  "mcp__t3__schedule_task",
  "mcp__t3__run_scheduled_task_now",
  "mcp__t3-code__delegate_task",
];

describe("orchestration MCP tools: the classifier", () => {
  for (const tool of LAUNCHES) {
    it(`refuses ${tool}, on any server`, () => {
      assert.equal(orchestrationLaunch(call(tool, { task: "x" }))?.tool, tool);
      assert.match(
        orchestrationRefusal(call(tool)) ?? "",
        /nested agent, started through an MCP tool/,
      );
    });
  }

  it("refuses the t3_workflow actions that run or wake a workflow, and an unknown one", () => {
    for (const action of ["start", "resume", "signal", "something-new", undefined]) {
      assert.ok(orchestrationLaunch(call("mcp__t3__t3_workflow", { action })), String(action));
    }
    for (const action of ["list", "read", "questions", "store", "cancel"]) {
      assert.equal(orchestrationLaunch(call("mcp__t3__t3_workflow", { action })), null, action);
    }
  });

  it("leaves other tools alone", () => {
    for (const tool of [
      "mcp__t3__t3_thread_read",
      "mcp__t3__task_status",
      "mcp__github__create_issue",
      "delegate_task",
      "Bash",
    ]) {
      assert.equal(orchestrationLaunch(call(tool)), null, tool);
    }
    assert.equal(orchestrationLaunch(null), null);
  });

  it("has a matcher both harnesses read as a regular expression for exactly these tools", () => {
    for (const tool of [...LAUNCHES, "mcp__t3__t3_workflow"]) {
      assert.ok(matcherSelects(ORCHESTRATION_MCP_MATCHER, tool), tool);
    }
    for (const tool of ["Bash", "PowerShell", "mcp__t3__t3_thread_read", "Write"]) {
      assert.equal(matcherSelects(ORCHESTRATION_MCP_MATCHER, tool), false, tool);
    }
  });
});

describe("orchestration MCP tools: kit gate-bash", () => {
  const gate = (payload: unknown) =>
    spawnSync(process.execPath, [CLI, "gate-bash"], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      env: { ...process.env, KIT_NO_UPDATE_CHECK: "1", KIT_AUDIT_ANCHOR: "0" },
      timeout: 60_000,
    });

  it("exits 2 for a call that starts an agent", () => {
    const run = gate(call("mcp__t3__delegate_task", { task: "push to main" }));
    assert.equal(run.status, 2, run.stderr);
    assert.match(run.stderr, /mcp__t3__delegate_task starts a child agent/);
  });

  it("exits 0 for a call that only reads a thread", () => {
    assert.equal(gate(call("mcp__t3__t3_thread_read", { threadId: "t" })).status, 0);
  });
});

function temp(prefix: string): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
}

describe("orchestration MCP tools: the installed matchers", () => {
  it("Claude Code: a group of its own, added to an existing gate once", async () => {
    const dir = temp("kit-orch-claude-");
    try {
      mkdirSync(join(dir, ".claude"));
      const file = join(dir, ".claude", "settings.json");
      type Group = { matcher: string; hooks: { command: string }[] };
      const groups = () => JSON.parse(readFileSync(file, "utf8")).hooks.PreToolUse as Group[];
      await installInstallGate(dir);
      assert.deepEqual(
        groups().map((g) => g.matcher),
        ["Bash|PowerShell", ORCHESTRATION_MCP_MATCHER],
      );
      // A gate wired before this change: the shell group only.
      writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [groups()[0]] } }));
      const r = await installInstallGate(dir);
      assert.equal(r.action, "updated");
      assert.match(r.detail ?? "", /MCP tools that start or steer an agent/);
      assert.deepEqual(
        groups().map((g) => g.matcher),
        ["Bash|PowerShell", ORCHESTRATION_MCP_MATCHER],
      );
      assert.match(groups()[1]!.hooks[0]!.command, /gate-bash/);
      assert.equal((await installInstallGate(dir)).action, "unchanged");
    } finally {
      rmTemp(dir);
    }
  });

  it("Codex: a second block, leaving the trusted ^Bash$ hook's hash as it was", async () => {
    const dir = temp("kit-orch-codex-");
    try {
      mkdirSync(join(dir, ".codex"));
      await installInstallGateCodex(dir);
      const path = join(dir, ".codex", "config.toml");
      const matchers = () =>
        (
          parseToml(readFileSync(path, "utf8")) as { hooks: { PreToolUse: { matcher: string }[] } }
        ).hooks.PreToolUse.map((g) => g.matcher);
      assert.deepEqual(matchers(), ["^Bash$", ORCHESTRATION_MCP_MATCHER]);
      const full = readFileSync(path, "utf8");
      const bashOnly = full.slice(0, full.lastIndexOf("\n[[hooks.PreToolUse]]") + 1);
      writeFileSync(path, bashOnly);
      const before = codexGateHooks(bashOnly)[0]!.hash;
      await installInstallGateCodex(dir);
      assert.deepEqual(matchers(), ["^Bash$", ORCHESTRATION_MCP_MATCHER]);
      assert.equal(codexGateHooks(readFileSync(path, "utf8"))[0]!.hash, before);
    } finally {
      rmTemp(dir);
    }
  });

  it("Codex trust: names the MCP hook as pending, and keeps the shell gate's verdict", async () => {
    const dir = temp("kit-orch-trust-");
    const home = temp("kit-orch-trust-home-");
    try {
      mkdirSync(join(dir, ".codex"));
      await installInstallGateCodex(dir);
      const shell = codexGateHooks(readFileSync(join(dir, ".codex", "config.toml"), "utf8"))[0]!;
      const key = `${join(dir, ".codex", "config.toml")}:pre_tool_use:0:0`;
      mkdirSync(join(home, ".codex"));
      writeFileSync(
        join(home, ".codex", "config.toml"),
        `[projects.'${dir}']\ntrust_level = "trusted"\n\n[hooks.state.'${key}']\ntrusted_hash = "${shell.hash}"\n`,
      );
      const [row] = checkCodexHookTrust(dir, home, {});
      assert.equal(row?.status, "warn");
      assert.match(row?.detail ?? "", /kit's gate runs; MCP tools that start an agent run ungated/);
      assert.match(row?.suggestion ?? "", /matcher `\^mcp__/);
    } finally {
      rmTemp(dir);
      rmTemp(home);
    }
  });
});
