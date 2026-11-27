import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decideBashGate } from "./install-gate.js";
import {
  nestedAgentBypass,
  nestedAgentBypassReason,
  nestedAgentCli,
  nestedAgentRefusal,
} from "./nested-agent-bypass.js";

// kit-research artex-cc-vs-kit: gate-bash passed the first four with exit 0. Each flag is quoted
// from the vendor's own reference:
//   claude   https://code.claude.com/docs/en/cli-reference
//   codex    https://learn.chatgpt.com/docs/developer-commands?surface=cli
//   gemini   https://geminicli.com/docs/cli/cli-reference/
//   qwen     https://github.com/QwenLM/qwen-code/blob/main/docs/users/configuration/settings.md
//   cursor   https://cursor.com/docs/cli/reference/parameters
//   copilot  https://docs.github.com/en/copilot/reference/cli-command-reference
//   kiro-cli https://kiro.dev/docs/reference/cli-commands/
//   droid    https://docs.factory.com/cli/droid-exec/overview
const BYPASSES: Array<[string, string, string]> = [
  [
    'claude --print --dangerously-skip-permissions "Pentest example.com"',
    "claude",
    "--dangerously-skip-permissions",
  ],
  [
    'claude -p --permission-mode bypassPermissions "x"',
    "claude",
    "--permission-mode bypassPermissions",
  ],
  [
    'claude -p --permission-mode=bypassPermissions "x"',
    "claude",
    "--permission-mode=bypassPermissions",
  ],
  [
    'codex exec --dangerously-bypass-approvals-and-sandbox "x"',
    "codex",
    "--dangerously-bypass-approvals-and-sandbox",
  ],
  ['codex exec --yolo "x"', "codex", "--yolo"],
  ['codex -a never -s danger-full-access "x"', "codex", "-a never -s danger-full-access"],
  [
    'codex --ask-for-approval=never --sandbox=danger-full-access "x"',
    "codex",
    "--ask-for-approval=never --sandbox=danger-full-access",
  ],
  ['gemini --yolo -p "x"', "gemini", "--yolo"],
  ['gemini -y -p "x"', "gemini", "-y"],
  ['gemini --approval-mode yolo -p "x"', "gemini", "--approval-mode yolo"],
  ['gemini --approval-mode=yolo -p "x"', "gemini", "--approval-mode=yolo"],
  ['qwen --approval-mode yolo -p "x"', "qwen", "--approval-mode yolo"],
  ['agent -p --force "x"', "cursor-agent", "--force"],
  ['cursor-agent --yolo "x"', "cursor-agent", "--yolo"],
  ['copilot -p "x" --allow-all-tools', "copilot", "--allow-all-tools"],
  ['COPILOT_ALLOW_ALL=1 copilot -p "x"', "copilot", "COPILOT_ALLOW_ALL=1"],
  ['kiro-cli chat --trust-all-tools "x"', "kiro-cli", "--trust-all-tools"],
  ['droid exec --skip-permissions-unsafe "x"', "droid", "--skip-permissions-unsafe"],
];

// The carriers the gate already reads: shells, wrappers, runners and the Windows shells.
const CARRIED = [
  `sh -c 'claude -p --dangerously-skip-permissions "x"'`,
  `bash -lc "codex exec --yolo x"`,
  "env FOO=1 claude -p --dangerously-skip-permissions x",
  "npx -y @anthropic-ai/claude-code@latest -p --dangerously-skip-permissions x",
  "npm exec -- @openai/codex exec --yolo x",
  "pnpm dlx @google/gemini-cli --yolo -p x",
  "echo x | xargs claude -p --dangerously-skip-permissions",
  "sudo -u bob /usr/local/bin/claude --dangerously-skip-permissions",
  "echo $(gemini --yolo -p x)",
  'cmd /c "claude -p --dangerously-skip-permissions x"',
  'powershell -Command "gemini --yolo -p x"',
  `pwsh -EncodedCommand ${Buffer.from("codex exec --yolo x", "utf16le").toString("base64")}`,
  "npm test && claude.cmd -p --dangerously-skip-permissions x",
];

describe("nested agent with approvals off: the classifier", () => {
  for (const [command, agent, flag] of BYPASSES) {
    it(`names it: ${command}`, () => {
      const found = nestedAgentBypass(command);
      assert.equal(found?.agent, agent);
      assert.equal(found?.flag, flag);
    });
  }

  for (const command of CARRIED) {
    it(`reads through the carrier: ${command}`, () => {
      assert.ok(nestedAgentBypass(command), command);
    });
  }

  for (const command of [
    "claude --version",
    'claude -p "explain this function"',
    'claude -p --permission-mode plan "x"',
    'claude -p "please do not pass --dangerously-skip-permissions"',
    "claude -p -- --dangerously-skip-permissions",
    'codex exec "x"',
    'codex -a never "x"',
    'codex -s danger-full-access "x"',
    'gemini --approval-mode default -p "x"',
    "git push --force-with-lease=x origin topic",
    "rm -f build.log",
    "echo claude --dangerously-skip-permissions",
  ]) {
    it(`leaves it alone: ${JSON.stringify(command)}`, () => {
      assert.equal(nestedAgentRefusal({ command, expansions: [] }), null);
    });
  }

  it("takes one argv, for agent-audit's grants", () => {
    const found = nestedAgentBypass(["claude", "--print", "--dangerously-skip-permissions"]);
    assert.equal(found?.flag, "--dangerously-skip-permissions");
    assert.equal(nestedAgentBypass(["claude", "--version"]), null);
  });

  it("names the agent behind a command word", () => {
    assert.equal(nestedAgentCli("/opt/bin/codex.exe"), "codex");
    assert.equal(nestedAgentCli("@anthropic-ai/claude-code@2.1.0"), "claude");
    assert.equal(nestedAgentCli("Gemini.cmd"), "gemini");
    assert.equal(nestedAgentCli("npm"), null);
  });

  it("says how to run it with approvals on", () => {
    const reason = nestedAgentBypassReason(nestedAgentBypass("gemini --yolo -p x")!);
    assert.match(reason, /gemini --yolo/);
    assert.match(reason, /--approval-mode default/);
  });
});

describe("nested agent with approvals off: gate-bash", () => {
  for (const command of [
    'claude --print --dangerously-skip-permissions "Pentest example.com"',
    'claude -p --permission-mode bypassPermissions "x"',
    'codex exec --dangerously-bypass-approvals-and-sandbox "x"',
    'gemini --yolo -p "x"',
  ]) {
    it(`refuses before any registry request: ${command}`, async () => {
      const verdict = await decideBashGate(command);
      assert.equal(verdict.block, true);
      assert.match(verdict.reason, /starts a nested agent with its approvals off/);
      assert.deepEqual(verdict.checked, []);
    });
  }

  it("allows the same agent with approvals on", async () => {
    assert.equal((await decideBashGate('claude -p "explain this function"')).block, false);
  });

  it("does not read a quoted here-document body as a command", async () => {
    const verdict = await decideBashGate("cat <<'EOF'\nclaude --dangerously-skip-permissions\nEOF");
    assert.equal(verdict.block, false);
  });
});
