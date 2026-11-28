import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installEnvWriteGate, installInstallGate } from "./agent-config.js";
import { checkGateLiveness } from "./check-security.js";
import {
  matcherSelects,
  staleGateBashMatchers,
  widenGateBashMatchers,
} from "./gate-bash-matcher.js";
import { ORCHESTRATION_MCP_MATCHER } from "./orchestration-mcp-tools.js";

interface Group {
  matcher?: string;
  hooks?: { command: string }[];
}

function project(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-pwsh-"));
  // An empty HOME, so a real ~/.claude/settings.json cannot add user-level gates.
  const prevHome = process.env.HOME;
  process.env.HOME = join(dir, "home");
  t.after(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(dir, { recursive: true, force: true });
  });
  mkdirSync(join(dir, ".claude"), { recursive: true });
  return dir;
}

/** Rewrite kit's gate-bash group to the matcher kit wrote before PowerShell was covered. */
function downgradeToBashOnly(dir: string): void {
  const path = join(dir, ".claude", "settings.json");
  const s = JSON.parse(readFileSync(path, "utf-8"));
  for (const g of s.hooks.PreToolUse as Group[]) if (holdsGateBash(g)) g.matcher = "Bash";
  writeFileSync(path, JSON.stringify(s, null, 2));
}

function preToolUse(dir: string): Group[] {
  const s = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf-8"));
  return s.hooks.PreToolUse as Group[];
}

/** A shell group running gate-bash; the group for agent-launching MCP tools is not one. */
const holdsGateBash = (g: Group) =>
  g.matcher !== ORCHESTRATION_MCP_MATCHER &&
  (g.hooks ?? []).some((h) => h.command.endsWith("gate-bash"));
const gate = (command = "/x/kit gate-bash") => ({ type: "command", command });

// https://code.claude.com/docs/en/hooks, "PowerShell" tool input: "Match `Bash|PowerShell` in
// hooks that inspect shell commands ... A hook that matches only `Bash` never fires there."
describe("Claude Code gate-bash matcher", () => {
  it("routes the PowerShell tool to gate-bash on a fresh install", async (t) => {
    const dir = project(t);
    await installInstallGate(dir);
    const gates = preToolUse(dir).filter(holdsGateBash);
    assert.equal(gates.length, 1);
    const names = (gates[0].matcher ?? "").split(/[|,]/).map((s) => s.trim());
    assert.ok(names.includes("Bash"), `matcher ${gates[0].matcher} must select Bash`);
    assert.ok(names.includes("PowerShell"), `matcher ${gates[0].matcher} must select PowerShell`);
  });

  it("kit check names an old Bash-only matcher and kit agent-config widens it once", async (t) => {
    const dir = project(t);
    await installInstallGate(dir);
    await installEnvWriteGate(dir);
    downgradeToBashOnly(dir);
    const before = await checkGateLiveness(dir, {});
    assert.equal(before.status, "fail", before.detail);
    assert.match(
      before.detail,
      /matcher "Bash" does not select both .*PowerShell.*kit agent-config/,
    );

    const repaired = await installInstallGate(dir);
    assert.equal(repaired.action, "updated");
    const gates = preToolUse(dir).filter(holdsGateBash);
    assert.deepEqual(
      gates.map((g) => g.matcher),
      ["Bash|PowerShell"],
      "one gate-bash group, widened in place",
    );
    assert.equal(gates[0].hooks?.length, 1, "no duplicate gate-bash hook");
    assert.equal((await installInstallGate(dir)).action, "unchanged");
    const after = await checkGateLiveness(dir, {});
    assert.equal(after.status, "pass", after.detail);
  });
});

describe("matcherSelects (Claude Code matcher rules)", () => {
  it("reads exact-name lists, match-all forms and regular expressions", () => {
    assert.ok(matcherSelects("Bash|PowerShell", "PowerShell"));
    assert.ok(matcherSelects("Bash, PowerShell", "PowerShell"));
    assert.ok(!matcherSelects("Bash", "PowerShell"));
    assert.ok(!matcherSelects("Bash|PowerShellX", "PowerShell"), "exact names, not a prefix");
    for (const all of [undefined, "", "*", ".*"]) assert.ok(matcherSelects(all, "PowerShell"));
    assert.ok(!matcherSelects("^Bash$", "PowerShell"));
    assert.ok(matcherSelects("^(Bash|PowerShell)$", "PowerShell"));
    assert.ok(!matcherSelects("(", "Bash"), "an invalid pattern selects nothing");
  });
});

describe("widenGateBashMatchers", () => {
  it("moves kit's gate out of a group it shares, leaving the other hook's matcher alone", () => {
    const mine = { type: "command", command: "/opt/mine.sh" };
    const groups = [{ matcher: "Bash", hooks: [mine, gate()] }];
    assert.deepEqual(staleGateBashMatchers(groups), ["Bash"]);
    assert.ok(widenGateBashMatchers(groups));
    assert.deepEqual(groups, [
      { matcher: "Bash", hooks: [mine] },
      { matcher: "Bash|PowerShell", hooks: [gate()] },
    ]);
    assert.deepEqual(staleGateBashMatchers(groups), []);
  });

  it("drops a stale duplicate when another group already covers both tools", () => {
    const groups = [
      { matcher: "^Bash$", hooks: [gate()] },
      { matcher: "Bash|PowerShell", hooks: [gate()] },
    ];
    assert.ok(widenGateBashMatchers(groups));
    assert.deepEqual(groups, [{ matcher: "Bash|PowerShell", hooks: [gate()] }]);
  });

  it("leaves covered and unrelated groups untouched", () => {
    const groups = [
      { matcher: "*", hooks: [gate()] },
      { matcher: "Bash", hooks: [gate("/x/kit gate-egress")] },
    ];
    const copy = structuredClone(groups);
    assert.ok(!widenGateBashMatchers(groups));
    assert.deepEqual(groups, copy);
  });
});
