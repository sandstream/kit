import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { StandardsRunResult } from "./standards-run.js";
import type { ReviewReport } from "./commands/review.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const source = import.meta.url.endsWith(".ts");
const gateUrl = new URL(source ? "./standards-run.ts" : "./standards-run.js", import.meta.url);
const commandUrl = new URL(
  source ? "./commands/standards.ts" : "./commands/standards.js",
  import.meta.url,
);
const loader = source ? ["--import", import.meta.resolve("tsx")] : [];
const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const serverUrl = new URL(source ? "./mcp-server.ts" : "./mcp-server.js", import.meta.url);
const clientUrl = import.meta.resolve("@modelcontextprotocol/sdk/client/index.js");
const transportUrl = import.meta.resolve("@modelcontextprotocol/sdk/inMemory.js");

interface ToolHealthInput {
  source: string;
  csv: string;
  exitCode: number;
  jscpdReport?: string;
  sccReport?: string;
  freeze?: boolean;
  surface?: "cli" | "mcp";
  text?: boolean;
}

function fixturePaths() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kit-standards-tool-health-")));
  const cwd = join(root, "project");
  const home = join(root, "home");
  const bin = join(root, "bin");
  const temporary = join(root, "tmp");
  const calls = join(root, "tool-calls.jsonl");
  const windows = process.platform === "win32";
  const preload = join(root, "tool-preload.cjs");
  return { root, cwd, home, bin, temporary, calls, windows, preload };
}

type FixturePaths = ReturnType<typeof fixturePaths>;

function toolReports(input: ToolHealthInput) {
  const lines = input.source ? input.source.trimEnd().split("\n").length : 0;
  const total = {
    lines,
    tokens: 0,
    sources: input.source ? 1 : 0,
    clones: 0,
    duplicatedLines: 0,
    duplicatedTokens: 0,
    percentage: 0,
    percentageTokens: 0,
  };
  const duplication =
    input.jscpdReport ??
    JSON.stringify({
      statistics: { total, formats: {} },
      duplicates: [],
    });
  const size =
    input.sccReport ??
    JSON.stringify(
      input.source ? [{ Name: "Python", Files: [{ Location: "main.py", Lines: lines }] }] : [],
    );
  return { duplication, size };
}

function installFixtureTools(input: ToolHealthInput, paths: FixturePaths) {
  const { bin, calls, windows } = paths;
  const { duplication, size } = toolReports(input);
  const executable = (name: string, body: string) => {
    if (windows) {
      copyFileSync(process.execPath, join(bin, `${name}.exe`));
      writeFileSync(join(bin, `${name}.cjs`), body);
    } else {
      writeFileSync(join(bin, name), `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
    }
  };
  // Only fixture tools can resolve. No host mise, shims, or personal tool stores run.
  executable(
    "mise",
    `const tool = process.argv[3];
  if (process.argv[2] !== "which" || !["lizard", "jscpd", "scc"].includes(tool)) process.exit(1);
  require("node:fs").writeSync(1, require("node:path").join(${JSON.stringify(bin)}, tool + ${JSON.stringify(windows ? ".exe" : "")}) + "\\n");`,
  );
  const record = (tool: string, exitCode: number) =>
    `require("node:fs").appendFileSync(${JSON.stringify(calls)}, ${JSON.stringify(JSON.stringify({ tool, exitCode }) + "\n")});\n`;
  executable(
    "lizard",
    `const args = process.argv.slice(2);
  if (!args.includes("--csv") || args[args.indexOf("--ignore_warnings") + 1] !== "-1") {
    require("node:fs").writeSync(2, "fixture requires CSV report mode with warnings ignored\\n");
    process.exit(2);
  }
  ` +
      record("lizard", input.exitCode) +
      `require("node:fs").writeSync(1, ${JSON.stringify(input.csv)});
  ${input.exitCode === 1 ? 'require("node:fs").writeSync(2, "Traceback (most recent call last):\\n  File \\"fixture\\", line 1, in analyze\\nIndexError: scanner crashed after its first function\\n");' : ""}
  ${input.exitCode === 2 ? 'require("node:fs").writeSync(2, "scanner crashed after its first function\\n");' : ""}
  process.exit(${input.exitCode});`,
  );
  executable(
    "jscpd",
    `const { values } = require("node:util").parseArgs({ options: { output: { type: "string" } }, strict: false, allowPositionals: true });
const output = values.output;
if (typeof output !== "string") process.exit(2);
  require("node:fs").writeFileSync(require("node:path").join(output, "jscpd-report.json"), ${JSON.stringify(duplication)});
  ` + record("jscpd", 0),
  );
  executable(
    "scc",
    `require("node:fs").writeSync(1, ${JSON.stringify(size)});\n` + record("scc", 0),
  );
}

function fixtureEnvironment(input: ToolHealthInput, paths: FixturePaths) {
  const { home, bin, temporary, windows, preload } = paths;
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    PATH: bin,
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_CACHE_HOME: join(home, "cache"),
    XDG_DATA_HOME: join(home, "data"),
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    TSX_DISABLE_CACHE: "1",
    KIT_DEFAULTS_FILE: join(home, "defaults.toml"),
    KIT_NO_UPDATE_CHECK: "1",
    KIT_NON_INTERACTIVE: "1",
    KIT_AUDIT_ANCHOR: "0",
    KIT_READ_ONLY: input.freeze ? "0" : "1",
    CI: "true",
  };
  if (windows) {
    // Node parses flags before preloads. Shield only fixture argv, then start real processes.
    writeFileSync(
      preload,
      `const path = require("node:path");
  const bin = ${JSON.stringify(bin)};
  const names = new Set(["mise", "lizard", "jscpd", "scc"]);
  const name = path.basename(process.execPath, ".exe").toLowerCase();
  if (path.dirname(process.execPath).toLowerCase() === bin.toLowerCase() && names.has(name)) {
    require(path.join(bin, name + ".cjs"));
    process.exit(0);
  }
  const cp = require("node:child_process");
  const original = cp.execFile;
  const custom = require("node:util").promisify.custom;
  function shield(argv) {
    const [file, args, ...rest] = argv;
    if (typeof file !== "string" || !Array.isArray(args)) return argv;
    const tool = path.basename(file).toLowerCase().replace(/\\.exe$/, "");
    const local = path.dirname(file) === "." || path.dirname(file).toLowerCase() === bin.toLowerCase();
    if (!local || !names.has(tool)) return argv;
    return [path.join(bin, tool + ".exe"), ["--", __filename, ...args], ...rest];
  }
  cp.execFile = (...argv) => Reflect.apply(original, cp, shield(argv));
  cp.execFile[custom] = (...argv) => Reflect.apply(original[custom], cp, shield(argv));
  require("node:module").syncBuiltinESMExports();
  `,
    );
    env.NODE_OPTIONS = `--require=${JSON.stringify(preload)}`;
  }
  return env;
}

function candidateScript(input: ToolHealthInput): string {
  return `import { runStandardsGate } from ${JSON.stringify(gateUrl.href)};
const result = await runStandardsGate({ cwd: process.cwd(), category: "general", enforce: true });
if (${input.surface === "cli"}) {
  const { spawnSync } = await import("node:child_process");
  const args = ${JSON.stringify(input.freeze ? [cliPath, "standards", "freeze"] : [cliPath, "standards", "--category", "general", ...(input.text ? [] : ["--enforce", "--json"])])};
  const cli = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 10000 });
  if (cli.error || cli.signal || cli.status === null) throw cli.error ?? new Error("CLI did not finish");
  result.cli = { exit: cli.status, stdout: cli.stdout, stderr: cli.stderr };
  if (!${Boolean(input.text || input.freeze)}) result.surface = JSON.parse(cli.stdout);
} else if (${input.surface === "mcp"}) {
  const { createMcpServer } = await import(${JSON.stringify(serverUrl.href)});
  const { Client } = await import(${JSON.stringify(clientUrl)});
  const { InMemoryTransport } = await import(${JSON.stringify(transportUrl)});
  const server = createMcpServer();
  const client = new Client({ name: "standards-evidence-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(b);
    await client.connect(a);
    const response = await client.callTool({ name: "kit_review", arguments: {
      cwd: process.cwd(), stages: ["standards"], category: "general", enforce: true,
    }});
    if (response.isError) throw new Error(JSON.stringify(response));
    result.mcp = JSON.parse(response.content.find((part) => part.type === "text").text);
  } finally { await client.close(); await server.close(); }
} else if (${Boolean(input.freeze)}) {
  const { cmdStandards } = await import(${JSON.stringify(commandUrl.href)});
  process.argv = [process.execPath, "kit", "standards", "freeze"];
  try { result.freezeAccepted = await cmdStandards(); }
  catch { result.freezeAccepted = false; }
}
console.log(JSON.stringify(result));`;
}

function assertToolCalls(calls: string, input: ToolHealthInput): string {
  const toolCalls = readFileSync(calls, "utf8");
  assert.ok(
    toolCalls.split("\n").includes(JSON.stringify({ tool: "lizard", exitCode: input.exitCode })),
    "the external lizard fixture must start with the required report-mode arguments",
  );
  assert.ok(
    toolCalls.split("\n").includes(JSON.stringify({ tool: "jscpd", exitCode: 0 })),
    "the external jscpd fixture must write its report before completing successfully",
  );
  assert.ok(
    toolCalls.split("\n").includes(JSON.stringify({ tool: "scc", exitCode: 0 })),
    "the external scc fixture must emit its report before completing successfully",
  );
  return toolCalls;
}

export function runToolHealthFixture(input: ToolHealthInput) {
  const paths = fixturePaths();
  const { root, cwd, home, bin, temporary, calls } = paths;
  try {
    for (const dir of [cwd, home, bin, temporary]) mkdirSync(dir);
    if (input.source) writeFileSync(join(cwd, "main.py"), input.source);
    const baselinePath = join(cwd, ".kit-baseline.json");
    const baselineBefore = JSON.stringify({
      version: 1,
      generated: "2026-01-01T00:00:00Z",
      categories: { standards: { complexity: ["main.py:accepted"] } },
    });
    if (input.freeze) writeFileSync(baselinePath, baselineBefore);
    installFixtureTools(input, paths);
    const env = fixtureEnvironment(input, paths);
    const child = spawnSync(
      process.execPath,
      [...loader, "--input-type=module", "--eval", candidateScript(input)],
      { cwd, env, encoding: "utf8", timeout: 20_000, maxBuffer: 1024 * 1024 },
    );
    assert.ifError(child.error);
    assert.equal(child.signal, null, child.stderr);
    assert.equal(child.status, 0, child.stderr);
    const toolCalls = assertToolCalls(calls, input);
    const reported = JSON.parse(child.stdout.trim().split(/\r?\n/).at(-1)!);
    return {
      gate: reported as StandardsRunResult,
      surface: reported.surface as StandardsRunResult | undefined,
      mcp: reported.mcp as ReviewReport | undefined,
      cli: reported.cli as { exit: number; stdout: string; stderr: string } | undefined,
      freezeAccepted: reported.freezeAccepted as boolean | undefined,
      baselineBefore,
      baselineAfter: input.freeze ? readFileSync(baselinePath, "utf8") : undefined,
      toolCalls,
    };
  } finally {
    rmTemp(root);
  }
}
