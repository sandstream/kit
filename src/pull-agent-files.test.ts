import { describe, it } from "node:test";
import assert from "node:assert/strict";
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
