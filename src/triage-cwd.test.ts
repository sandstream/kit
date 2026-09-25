import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  copyFileSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const MIRRORS = {
  KIT_NPM_REGISTRY: "npm_registry",
  KIT_PYPI_INDEX: "pypi_index",
  KIT_GITHUB_API: "github_api",
  KIT_DOCKER_REGISTRY: "docker_registry",
};

function mirrors(project: string): Record<string, string> {
  return {
    KIT_NPM_REGISTRY: `https://${project}.invalid/npm`,
    KIT_PYPI_INDEX: `https://${project}.invalid/pypi`,
    KIT_GITHUB_API: `https://${project}.invalid/github`,
    KIT_DOCKER_REGISTRY: `${project}.invalid/docker`,
  };
}

function writeMirrors(cwd: string, project: string): void {
  const values = mirrors(project);
  const lines = Object.entries(MIRRORS).map(([key, field]) => `${field} = "${values[key]}"`);
  writeFileSync(join(cwd, ".kit.toml"), ["[air_gap]", "enabled = true", ...lines].join("\n"));
}

// Stand in only for external executables: the real MCP handler, config loader,
// triage runner and process environment forwarding all execute unchanged.
function writeExecutables(bin: string): string | undefined {
  if (process.platform === "win32") {
    // execFile does not run shebang scripts or .cmd files on Windows. Use native
    // Node executables as the two external CLI fixtures, without a shell.
    for (const name of ["python3", "brew"]) {
      const executable = join(bin, `${name}.exe`);
      try {
        linkSync(process.execPath, executable);
      } catch {
        copyFileSync(process.execPath, executable);
      }
    }
    const loader = join(bin, "fixture-loader.mjs");
    writeFileSync(
      loader,
      [
        'import { basename } from "node:path";',
        "const command = basename(process.argv0).toLowerCase().replace(/\\.exe$/, '');",
        'if (command === "python3") {',
        `  const keys = ${JSON.stringify(Object.keys(MIRRORS))};`,
        "  console.log(JSON.stringify(Object.fromEntries(keys.flatMap(key =>",
        "    process.env[key] === undefined ? [] : [[key, process.env[key]]]))));",
        '  console.log("TRIAGE FAILED");',
        "  process.exit(0);",
        "}",
        'if (command === "brew") {',
        '  console.log(JSON.stringify({ formulae: [{ name: "fixture",',
        '    homepage: "https://github.com/fixture/repo" }] }));',
        "  process.exit(0);",
        "}",
      ].join("\n"),
    );
    return `--import=${pathToFileURL(loader).href}`;
  }
  symlinkSync(process.execPath, join(bin, "node"));
  writeFileSync(
    join(bin, "python3"),
    [
      "#!/usr/bin/env node",
      `const keys = ${JSON.stringify(Object.keys(MIRRORS))};`,
      "console.log(JSON.stringify(Object.fromEntries(keys.flatMap(key =>",
      "  process.env[key] === undefined ? [] : [[key, process.env[key]]]))));",
      'console.log("TRIAGE FAILED");',
    ].join("\n"),
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, "brew"),
    [
      "#!/usr/bin/env node",
      'console.log(JSON.stringify({ formulae: [{ name: "fixture",',
      '  homepage: "https://github.com/fixture/repo" }] }));',
    ].join("\n"),
    { mode: 0o755 },
  );
  return undefined;
}

async function withServer(
  env: Record<string, string>,
  run: (client: Client, projects: { A: string; B: string; empty: string }) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "kit-triage-cwd-"));
  const projects = { A: join(root, "A"), B: join(root, "B"), empty: join(root, "empty") };
  const home = join(root, "home");
  const bin = join(root, "bin");
  for (const dir of [...Object.values(projects), home, bin]) mkdirSync(dir);
  writeMirrors(projects.A, "server");
  writeMirrors(projects.B, "requested");
  const fixtureNodeOptions = writeExecutables(bin);
  const source = import.meta.url.endsWith(".ts");
  const entry = new URL(`./mcp-server.${source ? "ts" : "js"}`, import.meta.url).href;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      ...(source ? ["--import", import.meta.resolve("tsx")] : []),
      "--input-type=module",
      "-e",
      `const { startMcpServer } = await import(${JSON.stringify(entry)}); await startMcpServer();`,
    ],
    cwd: projects.A,
    env: {
      HOME: home,
      ...(process.platform === "win32" ? { USERPROFILE: home } : {}),
      PATH: bin,
      KIT_IDENTITY_DIR: join(home, "identity"),
      ...(fixtureNodeOptions ? { NODE_OPTIONS: fixtureNodeOptions } : {}),
      ...env,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "triage-cwd-test", version: "1" });
  try {
    await client.connect(transport);
    await run(client, projects);
  } finally {
    await client.close();
    await transport.close();
    rmSync(root, { recursive: true, force: true });
  }
}

async function observedMirrors(client: Client, cwd?: string, type = "npm"): Promise<unknown> {
  const result = await client.callTool({
    name: "kit_triage",
    arguments: { type, target: "fixture", cwd },
  });
  assert.equal(result.isError, true, "fixture emits a failed verdict without recording a pass");
  assert.ok(Array.isArray(result.content));
  const content = result.content[0];
  assert.equal(content.type, "text");
  const report = JSON.parse(content.text) as { output: string };
  return JSON.parse(report.output.split("\n")[0]);
}

describe("kit_triage resolves mirrors from requested cwd", () => {
  it("isolates simultaneous project requests and preserves the server default", async () => {
    await withServer({}, async (client, { A, B }) => {
      const results = await Promise.all([
        observedMirrors(client, B),
        observedMirrors(client, A),
        observedMirrors(client, "../B"),
      ]);
      assert.deepEqual(results, [mirrors("requested"), mirrors("server"), mirrors("requested")]);
      assert.deepEqual(await observedMirrors(client), mirrors("server"));
    });
  });

  it("a requested project without config does not inherit server mirrors", async () => {
    await withServer({}, async (client, { empty }) => {
      assert.deepEqual(await observedMirrors(client, empty), {});
    });
  });

  it("explicit environment overrides win over requested config", async () => {
    await withServer(
      { KIT_NPM_REGISTRY: "https://override.invalid/npm" },
      async (client, { B }) => {
        assert.deepEqual(await observedMirrors(client, B), {
          ...mirrors("requested"),
          KIT_NPM_REGISTRY: "https://override.invalid/npm",
        });
      },
    );
  });

  it("brew delegation retains the requested project's mirrors", async () => {
    await withServer({}, async (client, { B }) => {
      const result = await client.callTool({
        name: "kit_triage",
        arguments: { type: "brew", target: "fixture", cwd: B },
      });
      assert.ok(Array.isArray(result.content));
      const report = JSON.parse(result.content[0].text) as { output: string };
      assert.match(report.output, /Homebrew formula fixture -> upstream/);
      assert.deepEqual(JSON.parse(report.output.split("\n")[1]), mirrors("requested"));
    });
  });
});
