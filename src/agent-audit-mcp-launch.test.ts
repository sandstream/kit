/**
 * kit-research `artex-cc-vs-kit`: a committed `.mcp.json` running `go run ./cmd/artex-cc serve`
 * passed `kit agent-audit`, although it compiles and runs the checkout at every session start.
 * kit-research `shrink-anything-vs-kit`: `npx -y <pkg>` was "unpinned" to `kit triage skill` and
 * "no issues" to `kit agent-audit`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { repoCodeLaunch, unpinnedRunner, type McpLaunch } from "./agent-audit-mcp-launch.js";
import { runAgentAudit } from "./agent-audit.js";
import { PIN_CASES } from "./mcp-runner-pins.test-support.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

function checkout(t: { after(fn: () => void): void }, files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-mcp-launch-"));
  t.after(() => rmTemp(dir));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, ...rel.split("/"));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return dir;
}

const launch = (command: string, ...argv: string[]): McpLaunch => ({ server: "s", command, argv });

describe("repoCodeLaunch", () => {
  it("names a server that builds or runs the checkout's own code", (t) => {
    const root = checkout(t, { "localpkg/__init__.py": "" });
    const cases: [McpLaunch, string][] = [
      [launch("go", "run", "./cmd/artex-cc", "serve", "--stdio"), "go run ./cmd/artex-cc"],
      [launch("cargo", "run", "--release"), "cargo run"],
      [launch("node", "./server.js"), "node ./server.js"],
      [launch("node", "dist/cli.js", "mcp"), "node dist/cli.js"],
      [launch("python3", "-m", "localpkg.server"), "python3 -m localpkg.server"],
      [launch("npm", "run", "mcp"), "npm run mcp"],
      [launch("uv", "run", "server.py"), "uv run server.py"],
      [launch("./bin/server", "--stdio"), "./bin/server"],
      [launch("node", "${workspaceFolder}/dist/x.js"), "node ${workspaceFolder}/dist/x.js"],
    ];
    for (const [l, want] of cases) assert.equal(repoCodeLaunch(l, root), want, want);
  });

  it("leaves installed programs and remote packages alone", (t) => {
    const root = checkout(t, {});
    for (const l of [
      launch("npx", "-y", "@modelcontextprotocol/server-github"),
      launch("python3", "-m", "http.server"),
      launch("go", "run", "github.com/x/y@v1.2.3"),
      launch("deno", "run", "--allow-net", "jsr:@x/y"),
      launch("docker", "run", "-i", "--rm", "ghcr.io/x/y:1"),
      launch("/usr/local/bin/server"),
      launch("node", "/opt/server/index.js"),
    ]) {
      assert.equal(repoCodeLaunch(l, root), null, [l.command, ...l.argv].join(" "));
    }
  });
});

describe("unpinnedRunner (the triage skill's runner list and pinned test)", () => {
  it("calls a runner without a version unpinned, and a version pinned", () => {
    assert.equal(
      unpinnedRunner(launch("npx", "-y", "@el4cteo/shrink-anything", "mcp")),
      "npx @el4cteo/shrink-anything",
    );
    assert.equal(unpinnedRunner(launch("uvx", "mcp-server-fetch")), "uvx mcp-server-fetch");
    assert.equal(unpinnedRunner(launch("npx", "-y", "x@latest")), "npx x@latest");
    assert.equal(unpinnedRunner(launch("pnpm", "dlx", "x")), "pnpm dlx x");
    assert.equal(unpinnedRunner(launch("npx", "-y", "@scope/x@1.2.3")), null);
    assert.equal(unpinnedRunner(launch("uvx", "x@0.3.0")), null);
    assert.equal(unpinnedRunner(launch("node", "x")), null);
  });

  it("pins per ecosystem: npm semver, PyPI ==, a git source by its full commit", () => {
    for (const [command, args, want] of PIN_CASES) {
      assert.equal(unpinnedRunner(launch(command, ...args)), want, [command, ...args].join(" "));
    }
  });

  it("advises a commit for a git source and an exact version otherwise", (t) => {
    const root = checkout(t, {
      ".mcp.json": JSON.stringify({
        mcpServers: {
          git: { command: "uvx", args: ["--from", "git+https://github.com/o/r.git@main", "r"] },
          pypi: { command: "uvx", args: ["--from", "r>=1", "r"] },
        },
      }),
    });
    const advice = runAgentAudit(root).map((r) => r.suggestion ?? "");
    assert.match(advice.join("\n"), /pin a full commit \(@<commit>\)/);
    assert.match(advice.join("\n"), /pin an exact version \(name==1\.2\.3\)/);
  });
});

describe("runAgentAudit: MCP server launches", () => {
  it("warns, low, on the ARTEX-CC shape and the shrink-anything shape, and fails neither", (t) => {
    const root = checkout(t, {
      ".mcp.json": JSON.stringify({
        mcpServers: {
          artex: { command: "go", args: ["run", "./cmd/artex-cc", "serve", "--stdio"] },
          shrink: { command: "npx", args: ["-y", "@el4cteo/shrink-anything", "mcp"] },
        },
      }),
    });
    const rows = runAgentAudit(root).map((r) => [r.name, r.status, r.severity]);
    assert.deepEqual(rows, [
      ['MCP server "artex" in .mcp.json runs repository code at session start', "warn", "low"],
      ['unpinned MCP runner "shrink" in .mcp.json', "warn", "low"],
    ]);
  });

  it("agrees with triage skill's fixture, in .mcp.json and Codex's config.toml", (t) => {
    const root = checkout(t, {
      ".mcp.json": JSON.stringify({
        mcpServers: { lookup: { command: "npx", args: ["-y", "lookup-server-fixture@latest"] } },
      }),
      ".codex/config.toml":
        '[mcp_servers.lookup]\ncommand = "npx"\nargs = ["-y", "lookup-server-fixture@latest"]\n',
    });
    const names = runAgentAudit(root).map((r) => r.name);
    assert.ok(names.includes('unpinned MCP runner "lookup" in .mcp.json'), names.join("\n"));
    assert.ok(
      names.includes('unpinned MCP runner "lookup" in .codex/config.toml'),
      names.join("\n"),
    );
  });
});
