/**
 * What kit puts in front of an agent, pinned.
 *
 * Every byte kit injects competes for the model's attention in every session of every project that
 * installs it:
 *   - the managed CLAUDE.md / AGENTS.md block (`KIT_INSTRUCTION`), written into each project;
 *   - the MCP tool list (`tools/list`), paid once per session by any agent that connects;
 *   - the session-start line (`kit hooks context`), printed when declared git hooks do not run.
 *
 * T3 Code pins its own agent context the same way (kit-research `t3code-seven-practices-vs-kit`):
 * a measured budget that only moves on purpose. Here the budget is `agent-context-budget.json`
 * and this test requires the measurement to EQUAL it. Growth fails, so it shows up in the diff of
 * that file and the pull request has to say why. A cut fails too, so the file never drifts above
 * reality and a later increase cannot hide in the slack.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { KIT_INSTRUCTION } from "./agent-config.js";
import { hooksContextNote } from "./hooks-context.js";
import { createMcpServer } from "./mcp-server.js";

const BUDGET_FILE = join(resolve(import.meta.dirname, ".."), "src", "agent-context-budget.json");

interface Budget {
  claude_md_block_chars: number;
  mcp_tools_list_chars: number;
  mcp_tool_count: number;
  session_start_line_max_chars: number;
}

async function mcpToolList(): Promise<{ chars: number; count: number }> {
  const server = createMcpServer();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "context-budget", version: "1.0.0" }, { capabilities: {} });
  await server.connect(serverSide);
  await client.connect(clientSide);
  try {
    const { tools } = await client.listTools();
    return { chars: JSON.stringify(tools).length, count: tools.length };
  } finally {
    await client.close();
  }
}

/** The longest line `kit hooks context` can print: every standard hook, each broken. */
function longestSessionStartLine(): number {
  const hooks = ["pre-commit", "commit-msg", "pre-push", "post-checkout", "post-merge"];
  const note = hooksContextNote(
    hooks.map((hookName) => ({
      hookName,
      installed: true,
      executable: false,
      upToDate: false,
      detail: "",
    })),
  );
  return note?.length ?? 0;
}

describe("agent context budget", () => {
  it("what kit injects into an agent equals the pinned budget; change the budget on purpose", async () => {
    const budget = JSON.parse(readFileSync(BUDGET_FILE, "utf8")) as Budget;
    const mcp = await mcpToolList();
    const measured: Budget = {
      claude_md_block_chars: KIT_INSTRUCTION.length,
      mcp_tools_list_chars: mcp.chars,
      mcp_tool_count: mcp.count,
      session_start_line_max_chars: longestSessionStartLine(),
    };
    assert.deepEqual(
      measured,
      budget,
      "kit's injected agent context changed. If it grew, cut it or update " +
        "src/agent-context-budget.json and say why in the pull request; if it shrank, lower the budget.",
    );
  });
});
