/**
 * kit-research `prismor-always-allowed-rules-vs-kit`: `kit agent-audit` never listed a saved rule,
 * read no Codex, Cursor or Gemini rule, and did not notice deny rules being removed. The fixtures
 * are the note's Measurement §1 and §2 shapes.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { acceptRules, ruleBaselinePath, runRuleLedger } from "./agent-rule-ledger.js";
import { trailCommandRefusal } from "./trail-guard.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

type T = { after(fn: () => void): void };

function scratch(t: T, files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "kit-rule-ledger-"));
  t.after(() => rmTemp(dir));
  const home = join(dir, "home");
  const root = join(dir, "proj");
  const managed = join(dir, "managed");
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, ...rel.split("/"));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  mkdirSync(home, { recursive: true });
  mkdirSync(root, { recursive: true });
  return { dir, home, root, managed };
}

const perms = (p: Record<string, string[]>) => JSON.stringify({ permissions: p });

function ledger(s: ReturnType<typeof scratch>, record = false, today = "2026-11-27") {
  return runRuleLedger(s.root, s.home, {}, { record, today, managedDirs: [s.managed] });
}

const row = (l: ReturnType<typeof ledger>) =>
  l.rows.map((r) => [r.harness, r.scope, r.file, r.kind, r.rule, r.class]);

describe("agent rule ledger: one row per rule, per harness and scope", () => {
  it("lists Claude Code user, project, local and managed rules with the trifecta class", (t) => {
    const s = scratch(t, {
      "home/.claude/settings.json": perms({ allow: ["Bash(bash:*)"] }),
      "proj/.claude/settings.json": perms({
        allow: ["Bash(curl https://api.internal.example.com/*)", "Read(~/.zshrc)"],
        deny: ["Read(~/.ssh/**)"],
      }),
      "proj/.claude/settings.local.json": perms({ ask: ["Bash(git push:*)"] }),
      "managed/managed-settings.json": perms({ deny: ["WebFetch"] }),
      "managed/managed-settings.d/10-x.json": perms({ allow: ["Bash(npm test)"] }),
    });
    const got = row(ledger(s));
    assert.deepEqual(got.slice(0, 5), [
      [
        "Claude Code",
        "user",
        "~/.claude/settings.json",
        "allow",
        "Bash(bash:*)",
        "all three legs, writes",
      ],
      [
        "Claude Code",
        "project",
        ".claude/settings.json",
        "allow",
        "Bash(curl https://api.internal.example.com/*)",
        "untrusted input, way out",
      ],
      [
        "Claude Code",
        "project",
        ".claude/settings.json",
        "allow",
        "Read(~/.zshrc)",
        "private data",
      ],
      [
        "Claude Code",
        "project",
        ".claude/settings.json",
        "deny",
        "Read(~/.ssh/**)",
        "private data",
      ],
      ["Claude Code", "local", ".claude/settings.local.json", "ask", "Bash(git push:*)", "narrow"],
    ]);
    assert.deepEqual(
      got.slice(5).map((r) => [r[1], r[3], r[4]]),
      [
        ["managed", "deny", "WebFetch"],
        ["managed", "allow", "Bash(npm test)"],
      ],
    );
  });
});

describe("agent rule ledger: Codex, Cursor CLI and Gemini CLI", () => {
  it("reads Codex prefix rules (user and project), Cursor CLI and Gemini CLI", (t) => {
    const s = scratch(t, {
      "home/.codex/rules/default.rules": 'prefix_rule(pattern=["git", "push"], decision="allow")\n',
      "proj/.codex/rules/default.rules":
        'prefix_rule(pattern=["bash"], decision="allow")\nprefix_rule(pattern=["rm"], decision="forbidden")\n',
      "home/.cursor/cli-config.json": perms({ allow: ["Shell(bash)", "Shell(curl)"], deny: [] }),
      "proj/.cursor/cli.json": perms({ allow: ["Read(src/**)"] }),
      "proj/.gemini/settings.json": JSON.stringify({
        tools: { allowed: ["run_shell_command(bash)"], autoAccept: true },
      }),
    });
    const l = ledger(s);
    assert.deepEqual(row(l), [
      [
        "Codex",
        "user",
        "~/.codex/rules/default.rules",
        "allow",
        "prefix_rule: git push",
        "narrow, unsandboxed",
      ],
      [
        "Codex",
        "project",
        ".codex/rules/default.rules",
        "allow",
        "prefix_rule: bash",
        "all three legs, writes, unsandboxed",
      ],
      ["Codex", "project", ".codex/rules/default.rules", "deny", "prefix_rule: rm", "writes"],
      [
        "Cursor CLI",
        "user",
        "~/.cursor/cli-config.json",
        "allow",
        "Shell(bash)",
        "all three legs, writes",
      ],
      [
        "Cursor CLI",
        "user",
        "~/.cursor/cli-config.json",
        "allow",
        "Shell(curl)",
        "untrusted input, way out",
      ],
      ["Cursor CLI", "project", ".cursor/cli.json", "allow", "Read(src/**)", "narrow"],
      [
        "Gemini CLI",
        "project",
        ".gemini/settings.json",
        "allow",
        "run_shell_command(bash)",
        "all three legs, writes",
      ],
      [
        "Gemini CLI",
        "project",
        ".gemini/settings.json",
        "allow",
        "tools.autoAccept: true",
        "private data",
      ],
    ]);
    const wide = l.results.find(
      (r) => r.name === "agent rules: allow rules that hold all three legs",
    );
    assert.equal(wide?.status, "warn");
    assert.match(wide?.detail ?? "", /Codex \.codex\/rules\/default\.rules: prefix_rule: bash/);
    assert.match(wide?.detail ?? "", /Cursor CLI ~\/\.cursor\/cli-config\.json: Shell\(bash\)/);
    assert.ok(l.notCovered.some((h) => h.startsWith("Antigravity")));
    assert.ok(l.notCovered.some((h) => h.startsWith("Copilot")));
  });
});

describe("agent rule ledger: fail closed", () => {
  it("reports what it cannot parse instead of dropping it", (t) => {
    const s = scratch(t, {
      "proj/.claude/settings.json": "{ not json",
      "proj/.claude/settings.local.json": JSON.stringify({ permissions: { allow: [42] } }),
      "home/.codex/rules/x.rules": 'CMD = "bash"\nprefix_rule(pattern=[CMD])\n',
    });
    const l = ledger(s);
    assert.ok(l.rows.length >= 4);
    assert.ok(l.rows.every((r) => r.kind === "unparsed" && r.class === "unparsed"));
    const bad = l.results.find((r) => r.name === "agent rules: unparsed");
    assert.equal(bad?.status, "warn");
    assert.match(bad?.detail ?? "", /counts none of them as narrow/);
  });
});

describe("agent rule ledger: baseline", () => {
  it("records the first run, then flags a new allow and a removed deny until accepted", (t) => {
    const s = scratch(t, {
      "proj/.claude/settings.json": perms({
        deny: ["Read(~/.ssh/**)", "Bash(git push --force:*)"],
      }),
    });
    const first = ledger(s, true, "2026-11-01");
    assert.match(first.results.at(-1)?.detail ?? "", /baseline recorded for 2 rule/);
    assert.ok(existsSync(ruleBaselinePath(s.home)));

    writeFileSync(
      join(s.root, ".claude", "settings.json"),
      perms({ deny: ["Bash(git push --force:*)"] }),
    );
    writeFileSync(
      join(s.root, ".claude", "settings.local.json"),
      perms({ allow: ["Read(~/.ssh/**)"] }),
    );
    for (const today of ["2026-11-27", "2026-11-28"]) {
      const l = ledger(s, true, today);
      const removed = l.results.find((r) => r.name.endsWith("deny or ask rules removed"));
      const added = l.results.find((r) => r.name.endsWith("new allow rules"));
      assert.equal(removed?.severity, "high", "reported on every run");
      assert.match(
        removed?.detail ?? "",
        /deny Claude Code \.claude\/settings\.json: Read\(~\/\.ssh\/\*\*\)/,
      );
      assert.match(
        added?.detail ?? "",
        /\.claude\/settings\.local\.json: Read\(~\/\.ssh\/\*\*\) \[private data\]/,
      );
      const dates = Object.fromEntries(l.rows.map((r) => [r.rule + r.kind, r.firstSeen]));
      assert.deepEqual(dates, {
        "Bash(git push --force:*)deny": "2026-11-01",
        "Read(~/.ssh/**)allow": "2026-11-27",
      });
    }
    assert.equal(acceptRules(s.root, s.home, {}), 2);
    const after = ledger(s, true);
    assert.ok(after.results.every((r) => r.status === "pass"));
  });

  it("writes nothing in read-only mode", (t) => {
    const s = scratch(t, { "proj/.claude/settings.json": perms({ allow: ["Read"] }) });
    assert.equal(ledger(s, false).results.at(-1)?.status, "skip");
    assert.equal(existsSync(ruleBaselinePath(s.home)), false);
  });
});

describe("kit agent-audit (real CLI)", () => {
  it("lists rules in --json, scopes the trifecta pass to Claude Code, and the gate refuses --accept-rules", (t) => {
    const s = scratch(t, {
      "proj/.codex/rules/default.rules": 'prefix_rule(pattern=["git", "status"])\n',
    });
    const cli = resolve(dirname(fileURLToPath(import.meta.url)), "cli.js");
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [cli, "agent-audit", ...args], {
        cwd: s.root,
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: s.home,
          USERPROFILE: s.home,
          KIT_NO_UPDATE_CHECK: "1",
          KIT_AUDIT_ANCHOR: "0",
          CODEX_HOME: "",
          CLAUDE_CONFIG_DIR: "",
        },
        timeout: 60_000,
      });
    const out = JSON.parse(run("--json").stdout) as {
      rules: { harness: string; scope: string; rule: string }[];
      results: { name: string; detail: string }[];
      ledger: { read: string[] };
    };
    const local = out.rules.filter((r) => r.scope !== "managed"); // this machine's policy, if any
    assert.deepEqual(
      local.map((r) => [r.harness, r.rule]),
      [["Codex", "prefix_rule: git status"]],
    );
    assert.deepEqual(out.ledger.read, ["Claude Code", "Codex", "Cursor CLI", "Gemini CLI"]);
    const tri = out.results.find((r) => r.name === "lethal trifecta");
    assert.match(tri?.detail ?? "", /^no Claude Code session or subagent holds/);
    assert.match(
      run().stdout,
      /allow +Codex +project +\.codex\/rules\/default\.rules {2}prefix_rule: git status/,
    );
    writeFileSync(
      join(s.root, ".codex", "rules", "default.rules"),
      'prefix_rule(pattern=["git", "status"])\nprefix_rule(pattern=["git", "log"])\n',
    );
    assert.match(run().stdout, /new allow rules .*prefix_rule: git log/);
    const accepted = run("--accept-rules");
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.match(accepted.stdout, /accepted \d+ agent rule\(s\)/);
    assert.match(run().stdout, /none added or removed since accepted/);
    assert.match(
      trailCommandRefusal("kit agent-audit --accept-rules", s.home) ?? "",
      /a person does that/,
    );
    assert.equal(trailCommandRefusal("kit agent-audit --json", s.home), null);
  });
});
