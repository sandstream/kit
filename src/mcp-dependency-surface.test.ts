/**
 * kit installs 94 production packages and LOADS 9 of them.
 *
 * kit's four direct production dependencies are `@modelcontextprotocol/sdk`, `@upstash/redis`,
 * `smol-toml` and `zod`. 90 of the 94 packages in the tree are reachable ONLY through the SDK
 * (91 via the SDK in total; the other three direct deps close over 4), because it
 * declares 17 HARD dependencies (`optionalDependencies: {}`) that include a complete HTTP server
 * and OAuth stack — express 5, express-rate-limit, cors, hono, @hono/node-server, raw-body,
 * content-type, eventsource, jose, pkce-challenge — for the Streamable-HTTP and SSE transports.
 * kit speaks stdio. It imports exactly `server/mcp.js` and `server/stdio.js` in production.
 *
 * Three of the four dependency advisories this repo cleared in one sitting came from that tree:
 * fast-uri (via ajv), ip-address (via express-rate-limit) and hono itself. So "which of these does
 * kit actually execute?" stopped being idle curiosity and became the question that decides whether
 * a given advisory is a live code path or inherited surface.
 *
 * This test answers it mechanically instead of by reading the import graph, and it is a GUARD, not
 * a report: if a future SDK release starts pulling the HTTP stack into the stdio path, this fails.
 *
 * METHOD NOTE, because the first version of this measurement produced a false negative. An ESM
 * `resolve` hook alone reports 6 packages and MISSES fast-uri — `ajv` is CommonJS, so its internal
 * `require("fast-uri")` is invisible to the module-resolution hooks. The `Module._load` patch below
 * is what makes the CJS subtrees visible. A tracer that sees half the module system produces a
 * confident, rigorous-looking, wrong answer.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** The SDK's HTTP-transport and OAuth dependencies. kit must never load any of them. */
const HTTP_OAUTH_STACK = [
  "hono",
  "@hono/node-server",
  "express",
  "express-rate-limit",
  "cors",
  "raw-body",
  "content-type",
  "eventsource",
  "eventsource-parser",
  "jose",
  "pkce-challenge",
  "ip-address",
] as const;

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
      ["--import", join(dir, "register.mjs"), join(dir, "runner.mjs")],
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
      const m = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(line);
      if (m) packages.add(m[1]!);
    }
    return packages;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SERVER_DIST = resolve(import.meta.dirname, "mcp-server.js");

/**
 * Bare specifiers in the generated runner would resolve against ITS location — a temp dir with no
 * node_modules — not against the process's cwd. Resolve them here, from inside the repo, and embed
 * the absolute URLs. (The first version of this test failed with ERR_MODULE_NOT_FOUND for exactly
 * this reason; the earlier throwaway probe only worked because it symlinked node_modules.)
 */
const sdk = (subpath: string): string =>
  import.meta.resolve(`@modelcontextprotocol/sdk/${subpath}`);
const SDK_IN_MEMORY = sdk("inMemory.js");
const SDK_CLIENT = sdk("client/index.js");

describe("kit's MCP server loads none of the SDK's HTTP/OAuth stack", () => {
  it("building and connecting the server loads only the stdio + schema path", () => {
    const loaded = tracePackagesLoaded(
      [
        `const { createMcpServer } = await import(${JSON.stringify(SERVER_DIST)});`,
        `const { InMemoryTransport } = await import(${JSON.stringify(SDK_IN_MEMORY)});`,
        "const server = createMcpServer();",
        "const [, st] = InMemoryTransport.createLinkedPair();",
        "await server.connect(st);",
      ].join("\n"),
    );

    // SANITY FIRST. A tracer that recorded nothing would satisfy every negative assertion below,
    // so the test has to prove it can see anything at all before it is allowed to prove absence.
    assert.ok(
      loaded.has("@modelcontextprotocol/sdk"),
      `the tracer saw nothing — it must observe the SDK itself (saw: ${[...loaded].join(", ")})`,
    );
    assert.ok(loaded.has("zod"), "zod builds the tool schemas and must be observed");
    // BOTH halves of the tracer must be proven before absence means anything. `ajv` is reachable
    // through the ESM hook, so requiring it does not prove the CJS patch works — `fast-uri` is
    // only ever reached by ajv's internal require(), so it is the one that does. Blinding the
    // tracer to CommonJS has to fail HERE, not only in the fast-uri test below, or these negative
    // assertions would hold for a tracer that sees half the module system.
    assert.ok(loaded.has("ajv"), "ajv validates the schemas and must be observed (ESM half)");
    assert.ok(
      loaded.has("fast-uri"),
      "fast-uri is CJS-only — its absence means the tracer is blind to require(), not that the package is unused",
    );

    const leaked = HTTP_OAUTH_STACK.filter((p) => loaded.has(p));
    assert.deepEqual(
      leaked,
      [],
      `kit speaks stdio and must not load an HTTP/OAuth transport: ${leaked.join(", ")}`,
    );
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
        `const { createMcpServer } = await import(${JSON.stringify(SERVER_DIST)});`,
        `const { Client } = await import(${JSON.stringify(SDK_CLIENT)});`,
        `const { InMemoryTransport } = await import(${JSON.stringify(SDK_IN_MEMORY)});`,
        "const server = createMcpServer();",
        "const [ct, st] = InMemoryTransport.createLinkedPair();",
        'const client = new Client({ name: "p", version: "1.0.0" }, { capabilities: {} });',
        "await server.connect(st); await client.connect(ct);",
        "await client.listTools();",
        'await client.callTool({ name: "kit_context", arguments: {} });',
        'await client.callTool({ name: "kit_memory", arguments: { query: "x", limit: 1 } });',
        "await client.close();",
      ].join("\n"),
    );

    assert.ok(loaded.has("@modelcontextprotocol/sdk"), "sanity: the tracer must see the SDK");
    const leaked = HTTP_OAUTH_STACK.filter((p) => loaded.has(p));
    assert.deepEqual(
      leaked,
      [],
      `a tool call must not reach an HTTP/OAuth transport either: ${leaked.join(", ")}`,
    );
  });

  it("ajv and fast-uri ARE on the live path — the advisory class that is not merely inherited", () => {
    // Recorded as an assertion rather than a comment because I got this wrong once. When the
    // fast-uri advisory (GHSA-7p8r-x3mc-p8w7) was bumped, the commit message implied the package
    // was as untouched as hono. It is not: ajv compiles kit's ten tool schemas on every server
    // start and resolves `$ref` URIs through fast-uri. If a future refactor moves schema
    // validation off ajv this test should be updated deliberately, not silently.
    const loaded = tracePackagesLoaded(
      [
        `const { createMcpServer } = await import(${JSON.stringify(SERVER_DIST)});`,
        "createMcpServer();",
      ].join("\n"),
    );
    assert.ok(loaded.has("ajv"), "ajv is on the live path");
    assert.ok(
      loaded.has("fast-uri"),
      "fast-uri is reached through ajv — visible only with the CJS half of the trace",
    );
  });

  it("the loaded count ROADMAP advertises is the count this test measures", () => {
    // The numbers in the ROADMAP heading were prose, and prose drifts: it claimed "120 installed,
    // 9 loaded" for the 1.29 tree and still said 120 after the SDK 1.30 bump moved the install
    // count to 94. The loaded count did NOT move, which is exactly why it is worth pinning — it is
    // the number the upstream argument rests on, and a drifted number in a supply-chain argument is
    // worse than no number.
    //
    // Only the LOADED count is gated. The install count depends on the lockfile and on npm's
    // hoisting, so pinning it would fail on an unrelated dependency bump and teach people to edit
    // the assertion rather than read it.
    const loaded = tracePackagesLoaded(
      [
        `const { createMcpServer } = await import(${JSON.stringify(SERVER_DIST)});`,
        "createMcpServer();",
      ].join("\n"),
    );
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
