import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkMcpLoopbackToken, loopbackServersWithoutToken } from "./check-mcp-loopback-token.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const HTTP = "http:" + "//";
const servers = (s: Record<string, unknown>) => JSON.stringify({ mcpServers: s });

describe("loopbackServersWithoutToken", () => {
  it("names loopback http servers that send no credential", () => {
    const json = servers({
      a: { type: "http", url: `${HTTP}127.0.0.1:6277/mcp` },
      b: { url: `${HTTP}localhost:3000/mcp` },
      c: { url: `${HTTP}[::1]:8080/sse` },
      d: { serverUrl: `${HTTP}127.0.0.1:9001/mcp` },
    });
    assert.deepEqual(loopbackServersWithoutToken(json), [
      `a → ${HTTP}127.0.0.1:6277/mcp`,
      `b → ${HTTP}localhost:3000/mcp`,
      `c → ${HTTP}[::1]:8080/sse`,
      `d → ${HTTP}127.0.0.1:9001/mcp`,
    ]);
  });

  it("passes a server that sends a token in a header, an auth field or the URL", () => {
    const json = servers({
      bearer: { url: `${HTTP}127.0.0.1:1/mcp`, headers: { Authorization: "Bearer ${TOKEN}" } },
      apikey: { url: `${HTTP}127.0.0.1:2/mcp`, headers: { "X-API-Key": "${KEY}" } },
      helper: { url: `${HTTP}127.0.0.1:3/mcp`, headersHelper: "/usr/local/bin/get-token" },
      codex: { url: `${HTTP}127.0.0.1:4/mcp`, bearer_token_env_var: "MCP_TOKEN" },
      query: { url: `${HTTP}127.0.0.1:5/mcp?token=x` },
      init: { url: `${HTTP}127.0.0.1:6/mcp`, requestInit: { headers: { authorization: "x" } } },
    });
    assert.deepEqual(loopbackServersWithoutToken(json), []);
  });

  it("ignores remote, https, stdio and unauthenticated-looking headers that carry nothing", () => {
    const json = JSON.stringify({
      servers: {
        remote: { url: `${HTTP}mcp.example.invalid/mcp` },
        tls: { url: "https://127.0.0.1:8443/mcp" },
        stdio: { command: "node", args: ["server.js"] },
      },
      mcp: {
        empty: { url: `${HTTP}127.0.0.1:7/mcp`, headers: { Authorization: "", Accept: "x" } },
      },
    });
    assert.deepEqual(loopbackServersWithoutToken(json), [`empty → ${HTTP}127.0.0.1:7/mcp`]);
  });

  it("returns nothing for text that is not JSON", () => {
    assert.deepEqual(loopbackServersWithoutToken("[mcp_servers.x]"), []);
  });
});

describe("checkMcpLoopbackToken", () => {
  function repo(t: { after(fn: () => void): void }): string {
    const root = mkdtempSync(join(tmpdir(), "kit-mcptok-"));
    t.after(() => rmTemp(root));
    return root;
  }

  it("warns per config file and names the server", (t) => {
    const root = repo(t);
    writeFileSync(
      join(root, ".mcp.json"),
      servers({ inspector: { url: `${HTTP}127.0.0.1:6277/mcp` } }),
    );
    mkdirSync(join(root, ".vscode"));
    writeFileSync(
      join(root, ".vscode", "mcp.json"),
      JSON.stringify({ servers: { app: { url: `${HTTP}localhost:9001/mcp` } } }),
    );
    const rows = checkMcpLoopbackToken(root);
    assert.deepEqual(
      rows.map((r) => [r.name, r.status, r.severity]),
      [
        ["loopback MCP without a token in .mcp.json", "warn", "medium"],
        ["loopback MCP without a token in .vscode/mcp.json", "warn", "medium"],
      ],
    );
    assert.match(rows[0].detail, /inspector/);
  });

  it("is quiet on a repository whose loopback server sends a token", (t) => {
    const root = repo(t);
    writeFileSync(
      join(root, ".mcp.json"),
      servers({
        app: { url: `${HTTP}127.0.0.1:9001/mcp`, headers: { Authorization: "Bearer ${T}" } },
      }),
    );
    assert.deepEqual(checkMcpLoopbackToken(root), []);
  });

  it("is quiet without MCP configs", (t) => {
    assert.deepEqual(checkMcpLoopbackToken(repo(t)), []);
  });
});
