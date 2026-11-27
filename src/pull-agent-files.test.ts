import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { agentFileKind, agentFilesIn, pulledAgentFileLines } from "./pull-agent-files.js";

describe("agentFileKind", () => {
  it("names each surface the strutil-core worm commits", () => {
    assert.equal(agentFileKind(".claude/settings.json"), "agent settings (hooks, status line)");
    assert.equal(agentFileKind(".mcp.json"), "MCP servers");
    assert.equal(agentFileKind(".cursor/mcp.json"), "MCP servers");
    assert.equal(
      agentFileKind(".vscode/tasks.json"),
      "editor tasks (can run when the folder opens)",
    );
    assert.equal(agentFileKind(".gemini/settings.json"), "agent settings (hooks, MCP servers)");
    assert.equal(agentFileKind("AGENTS.md"), "agent instructions");
    assert.equal(agentFileKind("CLAUDE.md"), "agent instructions");
  });

  it("reads instruction files in any directory, and agent dirs by prefix", () => {
    assert.equal(agentFileKind("packages/api/AGENTS.md"), "agent instructions");
    assert.equal(agentFileKind(".github/copilot-instructions.md"), "agent instructions");
    assert.equal(agentFileKind(".claude/skills/deploy/run.sh"), "agent skill");
    assert.equal(agentFileKind(".github/workflows/ci.yml"), "CI workflow");
    assert.equal(agentFileKind(".husky/pre-commit"), "git hook");
  });

  it("leaves ordinary files alone, including look-alikes", () => {
    for (const p of [
      "README.md",
      "src/index.ts",
      ".github/init.js",
      "docs/CLAUDE.md.bak",
      "my.mcp.json",
    ])
      assert.equal(agentFileKind(p), null, p);
  });
});

describe("agentFilesIn", () => {
  it("keeps only the agent files, in order", () => {
    assert.deepEqual(agentFilesIn(["README.md", ".mcp.json", "src/a.ts", "AGENTS.md"]), [
      { file: ".mcp.json", kind: "MCP servers" },
      { file: "AGENTS.md", kind: "agent instructions" },
    ]);
  });
});

describe("pulledAgentFileLines", () => {
  const plain = { yellow: "", dim: "", reset: "" };
  it("prints nothing for no files", () => {
    assert.deepEqual(pulledAgentFileLines([], plain), []);
  });
  it("names each file and its kind, and caps the list at twenty", () => {
    const files = Array.from({ length: 22 }, (_, i) => ({
      file: `d${i}/AGENTS.md`,
      kind: "agent instructions",
    }));
    const lines = pulledAgentFileLines(files, plain);
    assert.equal(lines[0], "⚠ 22 file(s) an agent or editor runs or obeys:");
    assert.equal(lines[1], "  • d0/AGENTS.md  agent instructions");
    assert.ok(lines.includes("  … 2 more"));
  });
});

/**
 * The paths are read out of the sources as text, not imported (as `docs-agent-audit-files.test.ts`
 * does): both sources are protected paths that export none of these lists, and a second hand-kept
 * list is how the two drifted. `.git/` is never in a pull, so it is left out.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function source(rel: string): string {
  return readFileSync(resolve(root, "src", rel), "utf-8").replace(/^\s*\/\/.*$/gm, "");
}

function quoted(text: string, re: RegExp): string[] {
  return [...text.matchAll(re)].map((m) => m[1]).filter((p) => !p.startsWith(".git/"));
}

function block(text: string, name: string): string {
  const m = text.match(new RegExp(`const ${name}[^=]*= \\[([\\s\\S]*?)\\];`));
  assert.ok(m, `${name} not found`);
  return m[1];
}

/** Paths the agent audit reads: its config files, its agent dirs and its hook dirs. */
function agentAuditPaths(): { files: string[]; dirs: string[] } {
  const text = source("agent-audit.ts");
  return {
    files: quoted(block(text, "CONFIG_FILES"), /"([^"]+)"/g),
    dirs: [
      ...quoted(block(text, "AGENT_DIRS"), /dir: "([^"]+)"/g),
      ...quoted(block(text, "HOOK_DIRS"), /"([^"]+)"/g),
    ],
  };
}

/** Files kit's own `install*Gate*` functions write a gate into, and the settings files Claude's go to. */
function gateFiles(): string[] {
  const text = ["agent-config.ts", "agent-gate-installers.ts"].map(source).join("\n");
  const chunks = text.split(/\n(?=export (?:async )?function )/);
  const gates = chunks.filter((c) => /^export (?:async )?function install\w*Gate/.test(c));
  return [
    ...gates.flatMap((c) => quoted(c, /\bfile(?: =|:) "([^"]+)"/g)),
    ...quoted(source("gate-settings.ts"), /const \w+_SETTINGS = "([^"]+)"/g),
  ];
}

describe("agentFileKind covers what kit reads and writes elsewhere", () => {
  it("names every config file and agent/hook dir the agent audit reads", () => {
    const { files, dirs } = agentAuditPaths();
    assert.ok(files.length >= 10 && dirs.length >= 5, "extraction found too few paths");
    for (const f of files) assert.notEqual(agentFileKind(f), null, f);
    for (const d of dirs) assert.notEqual(agentFileKind(`${d}/x.json`), null, d);
  });

  it("names every file kit's agent config writes a gate into", () => {
    const files = gateFiles();
    assert.ok(files.length >= 8, "extraction found too few gate files");
    // Some installers name a directory of agent files (`.amazonq/cli-agents`): a file in it counts.
    for (const f of files)
      assert.notEqual(agentFileKind(f) ?? agentFileKind(`${f}/x.json`), null, f);
  });

  it("names the Codex, Cursor and Droid hook files as hooks", () => {
    for (const f of [".codex/hooks.json", ".cursor/hooks.json", ".factory/hooks.json"])
      assert.equal(agentFileKind(f), "agent hooks", f);
    assert.equal(agentFileKind(".codex/config.toml"), "agent config (hooks, MCP servers)");
  });
});
