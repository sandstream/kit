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
  it("marks referenced MCP servers used and missing references unknown without capture evidence", () => {
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
    assert.equal(some?.verdict, "unknown");
    assert.equal(some?.refs, 0);
    assert.deepEqual(report.pruneCandidates, []);
  });

  it("leaves skill verdict 'unknown' when no skill-usage map is provided (never 'unused')", () => {
    const report = computeUnused(
      { skills: [{ name: "pdf-process" }], mcpServers: [] },
      usage([["Bash", 5]]),
    );
    const skill = report.findings.find((f) => f.name === "pdf-process");
    assert.equal(skill?.kind, "skill");
    assert.equal(skill?.verdict, "unknown");
    assert.deepEqual(report.pruneCandidates, []);
  });

  it("keeps positive skill references but cannot recommend removal without capture evidence", () => {
    const report = computeUnused(
      { skills: [{ name: "doc-review" }, { name: "pdf-process" }], mcpServers: [] },
      [],
      new Map([["doc-review", 4]]),
    );
    const dr = report.findings.find((f) => f.name === "doc-review");
    const pdf = report.findings.find((f) => f.name === "pdf-process");
    assert.equal(dr?.verdict, "used");
    assert.equal(dr?.refs, 4);
    assert.equal(pdf?.verdict, "unknown");
    assert.equal(pdf?.refs, 0);
    assert.deepEqual(report.pruneCandidates, []);
  });
});

describe("computeUnused ordering and coverage", () => {
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

  it("with no usage or capture evidence, loaded MCP servers remain unknown", () => {
    const report = computeUnused({ skills: [], mcpServers: [{ name: "github" }] }, []);
    assert.equal(report.findings[0].verdict, "unknown");
    assert.deepEqual(report.pruneCandidates, []);
  });

  it("a complete flag without observed messages cannot justify removal", () => {
    const report = computeUnused(
      { skills: [{ name: "review" }], mcpServers: [{ name: "github" }] },
      [],
      new Map(),
      { complete: true, observedMessages: 0, incompleteMessages: 0, orphanToolCalls: 0 },
    );
    assert.ok(report.findings.every((finding) => finding.verdict === "unknown"));
    assert.deepEqual(report.pruneCandidates, []);
  });

  it("complete native tool evidence supports MCP absence but cannot establish skill absence", () => {
    const report = computeUnused(
      { skills: [{ name: "review" }], mcpServers: [{ name: "github" }] },
      [],
      new Map(),
      { complete: true, observedMessages: 1, incompleteMessages: 0, orphanToolCalls: 0 },
    );
    assert.equal(report.findings.find((finding) => finding.kind === "skill")?.verdict, "unknown");
    assert.equal(
      report.findings.find((finding) => finding.kind === "mcp-server")?.verdict,
      "unused",
    );
    assert.deepEqual(report.pruneCandidates, ["github"]);
    assert.equal(report.scope, "retained-indexed-messages");
    assert.equal(report.skillCoverage, "explicit-references-only");
  });
});
