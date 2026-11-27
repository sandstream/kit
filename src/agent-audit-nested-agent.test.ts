/**
 * kit-research `artex-cc-vs-kit`: `Bash(claude --print --dangerously-skip-permissions:*)` and
 * `Bash(claude:*)` passed the lethal-trifecta audit, while `Bash(bash:*)` warned twice. A grant to
 * start another coding agent with its approvals off, or with any flags, runs code nobody approves,
 * so it holds all three legs and is named. The agents and flags are the gate's own table
 * (`nested-agent-bypass.ts`); the Codex and Cursor shapes come from the rule ledger
 * (kit-research `prismor-always-allowed-rules-vs-kit`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { runRuleLedger } from "./agent-rule-ledger.js";
import { legsOf, nestedAgentGrant, runAgentTrifecta } from "./agent-trifecta.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

function project(t: { after(fn: () => void): void }, files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "kit-nested-agent-"));
  t.after(() => rmTemp(dir));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, ...rel.split("/"));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  mkdirSync(join(dir, "home"), { recursive: true });
  mkdirSync(join(dir, "proj"), { recursive: true });
  return { root: join(dir, "proj"), home: join(dir, "home") };
}

const allow = (...rules: string[]) => JSON.stringify({ permissions: { allow: rules } });

describe("nestedAgentGrant", () => {
  it("names approvals off and arbitrary flags; an exact command stays narrow", () => {
    const cases: [string, string | null][] = [
      ["claude --print --dangerously-skip-permissions:*", "approvals off"],
      ["claude -p --permission-mode bypassPermissions *", "approvals off"],
      ["codex exec --dangerously-bypass-approvals-and-sandbox:*", "approvals off"],
      ["gemini --yolo:*", "approvals off"],
      ["npx -y @anthropic-ai/claude-code --dangerously-skip-permissions:*", "approvals off"],
      ["claude:*", "arbitrary flags"],
      ["claude -p *", "arbitrary flags"],
      ["codex exec:*", "arbitrary flags"],
      ["claude --version", null],
      ["claude", null],
      ["git status:*", null],
    ];
    for (const [arg, kind] of cases) assert.equal(nestedAgentGrant(arg), kind, arg);
  });

  it("holds all three legs, like Bash(bash:*)", () => {
    for (const g of ["Bash(claude --print --dangerously-skip-permissions:*)", "Bash(claude:*)"]) {
      const l = legsOf([g]);
      assert.deepEqual([l.vector, l.payload, l.egress], [[g], [g], [g]], g);
    }
    const narrow = legsOf(["Bash(claude --version)"]);
    assert.deepEqual([narrow.vector, narrow.payload, narrow.egress], [[], [], []]);
  });
});

describe("lethal trifecta: a nested agent in Claude Code grants", () => {
  it("names the approvals-off grant, and warns as Bash(bash:*) does", (t) => {
    const p = project(t, {
      "proj/.claude/settings.json": allow("Bash(claude --print --dangerously-skip-permissions:*)"),
    });
    const names = runAgentTrifecta(p.root, p.home).map((r) => `${r.name} ${r.severity}`);
    assert.deepEqual(names, [
      "write access without confirmation: main session medium",
      "nested agent with approvals off: main session high",
      "lethal trifecta: main session medium",
    ]);
  });

  it("names a wildcard grant as arbitrary flags, and passes an exact one", (t) => {
    const wild = project(t, { "proj/.claude/settings.json": allow("Bash(claude:*)") });
    const rows = runAgentTrifecta(wild.root, wild.home);
    assert.ok(rows.some((r) => r.name === "nested agent with arbitrary flags: main session"));
    assert.ok(rows.some((r) => r.name === "lethal trifecta: main session"));
    const exact = project(t, { "proj/.claude/settings.json": allow("Bash(claude --version)") });
    assert.deepEqual(
      runAgentTrifecta(exact.root, exact.home).map((r) => r.status),
      ["pass"],
    );
  });
});

describe("agent rule ledger: a nested agent in Codex and Cursor rules", () => {
  it("classifies the grant and names it", (t) => {
    const p = project(t, {
      "proj/.codex/rules/default.rules":
        'prefix_rule(pattern=["codex", "exec", "--dangerously-bypass-approvals-and-sandbox"], decision="allow")\n',
      "proj/.cursor/cli.json": allow("Shell(claude)"),
    });
    const l = runRuleLedger(p.root, p.home, {}, { record: false, managedDirs: [] });
    assert.deepEqual(
      l.rows.map((r) => [r.harness, r.class]),
      [
        ["Codex", "all three legs, writes, nested agent with approvals off, unsandboxed"],
        ["Cursor CLI", "all three legs, writes, nested agent with arbitrary flags"],
      ],
    );
    const off = l.results.find((r) => r.name === "agent rules: nested agent with approvals off");
    assert.equal(off?.severity, "high");
    assert.match(off?.detail ?? "", /prefix_rule: codex exec --dangerously-bypass/);
    const any = l.results.find((r) => r.name === "agent rules: nested agent with arbitrary flags");
    assert.match(any?.detail ?? "", /Cursor CLI \.cursor\/cli\.json: Shell\(claude\)/);
  });
});
