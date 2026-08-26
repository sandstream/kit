import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { openMemoryDb } from "../memory/db.js";
import {
  mcpServerOf,
  tallyToolUsage,
  scanToolUsage,
  hasIndexedToolUsage,
  tallySkillUsage,
  scanSkillUsage,
} from "./usage-scan.js";

describe("mcpServerOf", () => {
  it("extracts the server slug from an mcp__server__tool name", () => {
    assert.equal(mcpServerOf("mcp__github__create_issue"), "github");
    assert.equal(mcpServerOf("mcp__some-server__do_thing"), "some-server");
  });
  it("returns null for non-MCP tools", () => {
    assert.equal(mcpServerOf("kit_check"), null);
    assert.equal(mcpServerOf("Bash"), null);
    assert.equal(mcpServerOf(""), null);
  });
  it("handles a server with no tool segment", () => {
    assert.equal(mcpServerOf("mcp__lonely"), "lonely");
    assert.equal(mcpServerOf("mcp__"), null);
  });
});

describe("tallyToolUsage", () => {
  it("counts, skips null/blank, and sorts by count desc then name asc", () => {
    const out = tallyToolUsage([
      "Bash",
      "Bash",
      "kit_check",
      null,
      "  ",
      undefined,
      "kit_check",
      "Bash",
      "mcp__github__x",
    ]);
    assert.deepEqual(
      out.map((e) => [e.tool, e.count]),
      [
        ["Bash", 3],
        ["kit_check", 2],
        ["mcp__github__x", 1],
      ],
    );
    // mcpServer is derived per entry.
    assert.equal(out.find((e) => e.tool === "mcp__github__x")?.mcpServer, "github");
    assert.equal(out.find((e) => e.tool === "Bash")?.mcpServer, null);
  });
  it("is deterministic for ties (name asc)", () => {
    const out = tallyToolUsage(["b", "a", "c"]);
    assert.deepEqual(
      out.map((e) => e.tool),
      ["a", "b", "c"],
    );
  });
  it("returns [] for no input", () => {
    assert.deepEqual(tallyToolUsage([]), []);
  });
});

describe("scanToolUsage", () => {
  it("groups tool_uses rows from the memory DB", () => {
    const db = openMemoryDb(":memory:");
    const insert = db.prepare(
      "INSERT INTO tool_uses (message_uuid, session_id, tool_name, tool_input, timestamp) VALUES (?, ?, ?, ?, ?)",
    );
    let i = 0;
    const add = (tool: string) => insert.run(`m${i++}`, "s1", tool, "{}", "2026-01-01T00:00:00Z");
    add("Bash");
    add("Bash");
    add("mcp__github__create_issue");
    add("kit_check");

    assert.equal(hasIndexedToolUsage(db), true);
    const out = scanToolUsage(db);
    assert.deepEqual(
      out.map((e) => [e.tool, e.count]),
      [
        ["Bash", 2],
        ["kit_check", 1],
        ["mcp__github__create_issue", 1],
      ],
    );
    assert.equal(out.find((e) => e.tool === "mcp__github__create_issue")?.mcpServer, "github");
    db.close();
  });

  it("reports no indexed usage for an empty DB (caller must skip, not claim all-unused)", () => {
    const db = openMemoryDb(":memory:");
    assert.equal(hasIndexedToolUsage(db), false);
    assert.deepEqual(scanToolUsage(db), []);
    db.close();
  });
});

describe("tallySkillUsage", () => {
  it("counts skill slugs from Skill tool_input, skipping malformed/blank", () => {
    const counts = tallySkillUsage([
      '{"skill":"doc-review","args":"x"}',
      '{"skill":"doc-review"}',
      '{"skill":"artifact-design"}',
      '{"skill":"  "}',
      "{not json",
      '{"noskill":true}',
      null,
    ]);
    assert.equal(counts.get("doc-review"), 2);
    assert.equal(counts.get("artifact-design"), 1);
    assert.equal(counts.size, 2);
  });
});

describe("scanSkillUsage", () => {
  it("reads only Skill tool_uses and tallies by slug", () => {
    const db = openMemoryDb(":memory:");
    const insert = db.prepare(
      "INSERT INTO tool_uses (message_uuid, session_id, tool_name, tool_input, timestamp) VALUES (?, ?, ?, ?, ?)",
    );
    let i = 0;
    const add = (tool: string, input: string) =>
      insert.run(`m${i++}`, "s1", tool, input, "2026-01-01T00:00:00Z");
    add("Skill", '{"skill":"triage"}');
    add("Skill", '{"skill":"triage"}');
    add("Bash", "{}"); // not a skill call — ignored
    add("Skill", '{"skill":"doc-review"}');

    const counts = scanSkillUsage(db);
    assert.equal(counts.get("triage"), 2);
    assert.equal(counts.get("doc-review"), 1);
    assert.equal(counts.size, 2);
    db.close();
  });
});
