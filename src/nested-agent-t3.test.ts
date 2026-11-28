/**
 * T3 Code starts the agent itself: `t3 thread start` launches a thread at the project's default
 * permission mode, Full access unless changed, and no flag on the command sets it (kit-research#241,
 * pingdotgg/t3code 0.1.13 read as data). gate-bash passed `t3 thread start . "…"` and
 * `t3 workflow start review` with exit 0. They are refused as nested-agent launches whatever their
 * flags; the read-only subcommands stay allowed.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decideBashGate } from "./install-gate.js";
import { nestedAgentGrant } from "./agent-trifecta.js";
import { nestedAgentBypass, nestedAgentRefusal } from "./nested-agent-bypass.js";

const LAUNCHES: Array<[string, string]> = [
  ['t3 thread start . "fix the failing tests"', "thread start"],
  ['t3 thread start . "x" --provider codex --model gpt-5 --worktree main', "thread start"],
  ['t3 thread send thr_1 "now push it"', "thread send"],
  ["t3 workflow start review", "workflow start"],
  ["t3 workflow resume run_1", "workflow resume"],
  ['t3 --log-level debug thread start . "x"', "thread start"],
  ['npx t3 thread start . "x"', "thread start"],
  [`bash -lc 't3 thread send thr_1 "x"'`, "thread send"],
  ['/usr/local/bin/t3 thread start . "x"', "thread start"],
];

describe("T3 Code launches: the classifier", () => {
  for (const [command, flag] of LAUNCHES) {
    it(`names it: ${command}`, () => {
      const found = nestedAgentBypass(command);
      assert.equal(found?.agent, "t3");
      assert.equal(found?.flag, flag);
    });
  }

  for (const command of [
    "t3 thread show thr_1",
    "t3 thread list --json",
    "t3 workflow list",
    "t3 workflow show run_1",
    "t3 --version",
    "t3 thread show -- thread start",
    "echo t3 thread start",
  ]) {
    it(`leaves it alone: ${JSON.stringify(command)}`, () => {
      assert.equal(nestedAgentRefusal({ command, expansions: [] }), null);
    });
  }

  it("says why no flag can make it safe, and who starts it instead", () => {
    const reason = nestedAgentRefusal({ command: 't3 thread start . "x"', expansions: [] });
    assert.match(reason ?? "", /starts or steers a nested agent \(t3 thread start\)/);
    assert.match(reason ?? "", /Full access \(approvals off\)/);
    assert.match(reason ?? "", /Settings → Threads → New threads → Permissions/);
  });

  it("reads a grant to run it as a nested agent with approvals off, for agent-audit", () => {
    assert.equal(nestedAgentGrant("t3 thread start:*"), "approvals off");
    assert.equal(nestedAgentGrant("t3:*"), "arbitrary flags");
    assert.equal(nestedAgentGrant("t3 thread show thr_1"), null);
  });
});

describe("T3 Code launches: gate-bash", () => {
  for (const [command] of LAUNCHES.slice(0, 5)) {
    it(`refuses: ${command}`, async () => {
      const verdict = await decideBashGate(command);
      assert.equal(verdict.block, true);
      assert.match(verdict.reason, /starts or steers a nested agent/);
      assert.deepEqual(verdict.checked, []);
    });
  }

  it("allows reading a thread", async () => {
    assert.equal((await decideBashGate("t3 thread show thr_1")).block, false);
  });
});
