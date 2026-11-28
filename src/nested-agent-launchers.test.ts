/**
 * A nested agent started through a launcher: `herdr pane new --kind <agent> -- <argv>` starts
 * `<agent> <argv>`, so the gate reads that argv as the agent's own (kit-research copybook-vs-kit:
 * both lines below passed gate-bash with exit 0 while the same flags on a bare CLI were refused).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decideBashGate } from "./install-gate.js";
import { nestedAgentBypass } from "./nested-agent-bypass.js";

const LAUNCHED: Array<[string, string, string]> = [
  [
    "herdr pane new --kind claude -- --session-id x --model m --permission-mode bypassPermissions",
    "claude",
    "--permission-mode bypassPermissions",
  ],
  [
    "herdr pane new --kind codex -- -m m -s danger-full-access -a never",
    "codex",
    "-a never -s danger-full-access",
  ],
  [
    "herdr pane new --kind=claude -- --dangerously-skip-permissions",
    "claude",
    "--dangerously-skip-permissions",
  ],
  ["herdr pane new --kind codex -- exec --yolo 'do x'", "codex", "--yolo"],
  [
    "herdr pane new -- claude --dangerously-skip-permissions",
    "claude",
    "--dangerously-skip-permissions",
  ],
  [
    "/usr/local/bin/herdr pane new --kind claude -- --permission-mode=bypassPermissions",
    "claude",
    "--permission-mode=bypassPermissions",
  ],
  [
    "sh -c 'herdr pane new --kind codex -- --dangerously-bypass-approvals-and-sandbox'",
    "codex",
    "--dangerously-bypass-approvals-and-sandbox",
  ],
  ["cd /w && herdr pane new --kind gemini -- --yolo", "gemini", "--yolo"],
];

describe("nested agent through a launcher", () => {
  for (const [command, agent, flag] of LAUNCHED) {
    it(`refuses: ${command}`, async () => {
      assert.deepEqual(
        (({ agent, flag }) => ({ agent, flag }))(
          nestedAgentBypass(command) ?? { agent: "", flag: "" },
        ),
        { agent, flag },
      );
      const verdict = await decideBashGate(command);
      assert.equal(verdict.block, true);
      assert.match(verdict.reason, /starts a nested agent with its approvals off/);
    });
  }

  it("allows launched agents with approvals on and herdr's other commands", async () => {
    for (const command of [
      "herdr pane new --kind claude -- --session-id x --model m",
      "herdr pane new --kind codex -- -s workspace-write -a on-request",
      "herdr pane list",
      "herdr pane new --kind claude",
      "herdr workspace list --json",
      "herdr pane new --kind shell -- echo --yolo",
    ]) {
      assert.equal(nestedAgentBypass(command), null, command);
      assert.equal((await decideBashGate(command)).block, false, command);
    }
  });
});
