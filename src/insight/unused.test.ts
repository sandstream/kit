import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeUnused } from "./unused.js";
import type { ToolUsageEntry } from "./usage-scan.js";

const usage = (rows: [string, number][]): ToolUsageEntry[] =>
  rows.map(([tool, count]) => ({
    tool,
    count,
    mcpServer: tool.startsWith("mcp__") ? tool.slice(5).split("__")[0] : null,
  }));

describe("computeUnused", () => {
  it("marks a loaded MCP server used when any of its tools was called, else unused", () => {
    const report = computeUnused(
      {
        skills: [],
        mcpServers: [{ name: "github" }, { name: "some-server" }],
      },
      usage([
        ["mcp__github__create_issue", 3],
        ["mcp__github__list_prs", 2],
        ["Bash", 10],
      ]),
    );
    const github = report.findings.find((f) => f.name === "github");
    const some = report.findings.find((f) => f.name === "some-server");
    assert.equal(github?.verdict, "used");
    assert.equal(github?.refs, 5); // summed across the server's tools
    assert.equal(some?.verdict, "unused");
    assert.equal(some?.refs, 0);
    assert.deepEqual(report.pruneCandidates, ["some-server"]);
  });

  it("never judges a skill 'unused' — verdict is 'unknown' until skill-usage detection lands", () => {
    const report = computeUnused(
      { skills: [{ name: "pdf-process" }], mcpServers: [] },
      usage([["Bash", 5]]),
    );
    const skill = report.findings.find((f) => f.name === "pdf-process");
    assert.equal(skill?.kind, "skill");
    assert.equal(skill?.verdict, "unknown");
    assert.deepEqual(report.pruneCandidates, []); // skills are never prune candidates here
  });

  it("orders findings skills-first then mcp-servers, each by name asc (deterministic)", () => {
    const report = computeUnused(
      {
        skills: [{ name: "z-skill" }, { name: "a-skill" }],
        mcpServers: [{ name: "z-srv" }, { name: "a-srv" }],
      },
      usage([["mcp__a-srv__x", 1]]),
    );
    assert.deepEqual(
      report.findings.map((f) => f.name),
      ["a-skill", "z-skill", "a-srv", "z-srv"],
    );
    assert.deepEqual(report.loaded, { skills: 2, mcpServers: 2 });
  });

  it("with no usage, every loaded MCP server is unused (caller decides whether to skip)", () => {
    const report = computeUnused({ skills: [], mcpServers: [{ name: "github" }] }, []);
    assert.equal(report.findings[0].verdict, "unused");
    assert.deepEqual(report.pruneCandidates, ["github"]);
  });
});
