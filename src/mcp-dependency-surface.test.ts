/**
 * kit installs 2 production packages, and its MCP server loads only those.
 *
 * Until 19 November 2026 kit served MCP through `@modelcontextprotocol/sdk`, which accounted for
 * 91 of 94 installed packages: a complete HTTP server and OAuth stack (express, hono, jose and
 * others) for transports kit does not use. kit now serves stdio with `src/mcp-stdio.ts`, and the
 * SDK is a development dependency that only the tests use. See
 * docs/plans/2026-11-18-few-dependencies.md.
 *
 * This is a GUARD, not a report. It traces which `node_modules` packages the server really loads,
 * and fails if one that is not a declared runtime dependency shows up. That is how the SDK, or any
 * package pulled in by a later change, would be caught on the live path.
 *
 * METHOD NOTE, because the first version of this measurement produced a false negative. An ESM
 * `resolve` hook alone misses packages that are reached through `require()`, which is invisible to
 * the module-resolution hooks. The `Module._load` patch below makes CommonJS visible. A tracer that
 * sees half the module system produces a confident, rigorous-looking, wrong answer.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { rmTemp } from "./temp-cleanup.test-support.js";

/**
 * Boot an MCP server in a child process with both module systems traced, and return the set of
 * node_modules packages that were loaded.
 */
function tracePackagesLoaded(body: string): Set<string> {
  const dir = mkdtempSync(join(tmpdir(), "kit-depsurface-"));
  const log = join(dir, "loaded.txt");
  try {
    writeFileSync(
      join(dir, "hooks.mjs"),
      [
        'import { appendFileSync } from "node:fs";',
        "const OUT = process.env.KIT_MODLOG;",
        "export async function resolve(spec, ctx, next) {",
        "  const r = await next(spec, ctx);",
        "  try { appendFileSync(OUT, r.url + String.fromCharCode(10)); } catch {}",
        "  return r;",
        "}",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "register.mjs"),
      [
        'import { register } from "node:module";',
        'import Module from "node:module";',
        'import { appendFileSync } from "node:fs";',
        'register("./hooks.mjs", import.meta.url);',
        "// The ESM hook above is blind to CommonJS. Without this, ajv's require('fast-uri') and",
        "// every other CJS subtree go unreported and the negative assertions below pass falsely.",
        "const OUT = process.env.KIT_MODLOG;",
        "const origLoad = Module._load;",
        "Module._load = function (request, parent, isMain) {",
        "  const m = origLoad.call(this, request, parent, isMain);",
        "  try {",
        "    appendFileSync(OUT, Module._resolveFilename(request, parent, isMain) + String.fromCharCode(10));",
        "  } catch {}",
        "  return m;",
        "};",
      ].join("\n"),
    );
    writeFileSync(join(dir, "runner.mjs"), body);

    execFileSync(
      process.execPath,
      ["--import", pathToFileURL(join(dir, "register.mjs")).href, join(dir, "runner.mjs")],
      {
        // cwd is the repo root so the child resolves kit's own node_modules.
        cwd: resolve(import.meta.dirname, ".."),
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 120_000,
        env: { ...process.env, KIT_MODLOG: log, KIT_HIDE_HOOK_SKIP_BANNER: "1" },
      },
    );

    const packages = new Set<string>();
    for (const line of readFileSync(log, "utf-8").split("\n")) {
      const m = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(line.replaceAll("\\", "/"));
      if (m) packages.add(m[1]!);
    }
    return packages;
  } finally {
    rmTemp(dir);
  }
}

const SERVER_DIST = pathToFileURL(resolve(import.meta.dirname, "mcp-server.js")).href;
const STDIO_DIST = pathToFileURL(resolve(import.meta.dirname, "mcp-stdio.js")).href;

/** The only packages the server may load. Held equal to `dependencies` by dependency-floor.test.ts. */
const RUNTIME_DEPENDENCIES = ["smol-toml", "zod"];

/** Start the server on in-process streams and send it a list of JSON-RPC requests. */
const serve = (requests: object[]): string =>
  [
    `const { createMcpServer } = await import(${JSON.stringify(SERVER_DIST)});`,
    `const { stdioTransport } = await import(${JSON.stringify(STDIO_DIST)});`,
    'const { PassThrough } = await import("node:stream");',
    "const input = new PassThrough(), output = new PassThrough();",
    "const server = createMcpServer();",
    "await server.connect(stdioTransport(input, output));",
    ...requests.map((r) => `input.write(${JSON.stringify(`${JSON.stringify(r)}\n`)});`),
    "input.end(); await server.closed;",
  ].join("\n");

const request = (id: number, method: string, params?: object): object => ({
  jsonrpc: "2.0",
  id,
  method,
  ...(params ? { params } : {}),
});

describe("kit's MCP server loads only its declared runtime dependencies", () => {
  it("the tracer sees both halves of the module system, so absence means something", () => {
    // A tracer that recorded nothing would satisfy every absence assertion below. `zod` proves the
    // ESM half; `fast-uri` is CommonJS-only and is reached by a plain require(), which only the
    // Module._load patch can see. Blinding the tracer to either half has to fail HERE.
    const loaded = tracePackagesLoaded(
      [
        'import { createRequire } from "node:module";',
        `await import(${JSON.stringify(import.meta.resolve("zod"))});`,
        `createRequire(${JSON.stringify(import.meta.url)})("fast-uri");`,
      ].join("\n"),
    );
    assert.ok(loaded.has("zod"), "the ESM half must see zod");
    assert.ok(loaded.has("fast-uri"), "the CommonJS half must see a package reached by require()");
  });

  it("building and starting the server loads nothing beyond zod and smol-toml", () => {
    const loaded = tracePackagesLoaded(serve([]));
    assert.ok(loaded.has("zod"), "zod builds the tool schemas and must be observed");
    const extra = [...loaded].filter((p) => !RUNTIME_DEPENDENCIES.includes(p));
    assert.deepEqual(extra, [], `not a declared runtime dependency: ${extra.join(", ")}`);
  });

  it("listing tools and calling two of them loads nothing further", () => {
    const loaded = tracePackagesLoaded(
      [
        'import { mkdtempSync, writeFileSync } from "node:fs";',
        'import { tmpdir } from "node:os";',
        'import { join } from "node:path";',
        'const d = mkdtempSync(join(tmpdir(), "kit-depsurface-call-"));',
        'writeFileSync(join(d, ".kit.toml"), "version = 1\\n");',
        `writeFileSync(join(d, "package.json"), ${JSON.stringify('{"name":"m","version":"1.0.0","private":true}\n')});`,
        // Never let a probe mint or touch the real ~/.kit identity key.
        'process.env.KIT_IDENTITY_DIR = join(d, ".id");',
        "process.chdir(d);",
        serve([
          request(1, "initialize", {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "p", version: "1" },
          }),
          request(2, "tools/list", {}),
          request(3, "tools/call", { name: "kit_context", arguments: {} }),
          request(4, "tools/call", { name: "kit_memory", arguments: { query: "x", limit: 1 } }),
        ]),
      ].join("\n"),
    );
    const extra = [...loaded].filter((p) => !RUNTIME_DEPENDENCIES.includes(p));
    assert.deepEqual(extra, [], `a tool call must not load: ${extra.join(", ")}`);
  });

  it("the loaded count ROADMAP advertises is the count this test measures", () => {
    // Only the LOADED count is gated. The install count depends on the lockfile and on npm's
    // hoisting, so pinning it here would fail on an unrelated dependency bump. The floor test holds
    // the declared dependencies instead.
    const loaded = tracePackagesLoaded(serve([]));
    const roadmap = readFileSync(resolve(import.meta.dirname, "..", "ROADMAP.md"), "utf-8");
    const heading =
      /### Shrink the inherited dependency surface — (\d+) installed, (\d+) loaded/.exec(roadmap);
    assert.ok(heading, "the ROADMAP heading carrying these numbers must still be findable");
    assert.equal(
      Number(heading[2]),
      loaded.size,
      `ROADMAP advertises ${heading[2]} loaded packages; the trace measures ${loaded.size} (${[...loaded].sort().join(", ")})`,
    );
  });
});
