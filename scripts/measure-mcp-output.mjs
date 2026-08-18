// Measure what kit's MCP surface actually costs an agent, in this repo, right now.
//
// Two numbers get confused with each other and only one of them dominates:
//
//   standing surface  — the tool schemas from `tools/list`, paid ONCE per session
//   response          — one kit_check answer, paid on EVERY call, and an agent in a
//                       check → fix → check loop calls it repeatedly
//
// A full kit_check response measured larger than the entire standing surface, which is why
// the response is summarized by default and the complete run is offloaded to a file. This
// script is how that claim stays honest: run it after touching the MCP surface and compare.
//
//   node scripts/measure-mcp-output.mjs
//
// Runs every real scanner (it is a real check), so it takes as long as `kit check` does.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../dist/mcp-server.js";

const server = createMcpServer();
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "measure-mcp-output", version: "1.0.0" }, { capabilities: {} });
await server.connect(serverTransport);
await client.connect(clientTransport);

const chars = (r) => r.content.reduce((n, c) => n + c.text.length, 0);
const check = (args) =>
  client.callTool({ name: "kit_check", arguments: args }, undefined, { timeout: 600_000 });

const summary = await check({});
const full = await check({ detail: true });
const { tools } = await client.listTools();

const s = chars(summary);
const f = chars(full);
const parsed = JSON.parse(summary.content[0].text);

console.log(
  JSON.stringify(
    {
      standingSurfaceChars: JSON.stringify(tools).length,
      fullResponseChars: f,
      summaryResponseChars: s,
      reductionPct: +(100 * (1 - s / f)).toFixed(1),
      approxTokens: { full: Math.round(f / 4), summary: Math.round(s / 4) },
      counts: parsed.counts,
      findings: parsed.findings.length,
      detailPath: parsed.detail?.path ?? null,
    },
    null,
    2,
  ),
);
await client.close();
