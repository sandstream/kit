import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { cmdSecrets } from "./secrets.js";
import { _resetConsumedElevationForTests } from "../elevation.js";

it("rejects invalid OneCLI environment key names before any registration side effect", async () => {
  const project = mkdtempSync(join(tmpdir(), "kit-onecli-keyname-"));
  const originalCwd = process.cwd();
  const originalArgv = process.argv;
  const originalError = console.error;
  const errors: string[] = [];
  try {
    process.chdir(project);
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
    for (const key of ["TOKEN.*", "TOKEN=OTHER", "TOKEN\nOTHER", "9TOKEN"]) {
      process.argv = [
        originalArgv[0],
        originalArgv[1],
        "secrets",
        "onecli",
        "register",
        key,
        "--host",
        "example.com",
      ];
      assert.equal(await cmdSecrets(), false);
      assert.match(errors.at(-1) ?? "", /invalid.*environment.*key/i);
      assert.equal(existsSync(join(project, ".env.local")), false);
      assert.equal(existsSync(join(project, ".kit-audit.jsonl")), false);
    }
  } finally {
    console.error = originalError;
    process.argv = originalArgv;
    process.chdir(originalCwd);
    rmSync(project, { recursive: true, force: true });
  }
});

it("refuses to replace a symlinked .env.local after registering with OneCLI", async () => {
  const project = mkdtempSync(join(tmpdir(), "kit-onecli-symlink-"));
  const originalCwd = process.cwd();
  const originalArgv = process.argv;
  const originalEnv = {
    KIT_ELEVATED: process.env.KIT_ELEVATED,
    ONECLI_API_KEY: process.env.ONECLI_API_KEY,
    ONECLI_API_URL: process.env.ONECLI_API_URL,
  };
  let registrations = 0;
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/api/health" || request.url === "/api/user") {
      response.end("{}");
    } else if (request.url === "/api/secrets") {
      registrations++;
      response.end('{"id":"registered-secret","name":"API_TOKEN"}');
    } else {
      response.writeHead(404).end("{}");
    }
  });
  try {
    server.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    process.env.ONECLI_API_URL = `http://127.0.0.1:${address.port}`;
    process.env.ONECLI_API_KEY = "test-api-key";
    process.env.KIT_ELEVATED = "1";
    writeFileSync(
      join(project, ".kit.toml"),
      '[secrets]\nstore = "1password"\n[secrets.keys.API_TOKEN]\nsource = "config"\nvalue = "test-secret-value"\n',
    );
    const outside = join(project, "outside.txt");
    writeFileSync(outside, "must remain unchanged\n");
    symlinkSync(outside, join(project, ".env.local"));
    process.chdir(project);
    process.argv = [
      originalArgv[0],
      originalArgv[1],
      "secrets",
      "onecli",
      "register",
      "API_TOKEN",
      "--host",
      "api.example.com",
    ];

    assert.equal(await cmdSecrets(), false);
    assert.equal(registrations, 1);
    assert.equal(readFileSync(outside, "utf8"), "must remain unchanged\n");
  } finally {
    process.argv = originalArgv;
    process.chdir(originalCwd);
    for (const [name, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    _resetConsumedElevationForTests();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(project, { recursive: true, force: true });
  }
});
