/**
 * `kit mcp` sub-commands, driven in process: list, auth, set-token and clear. They pin what an
 * operator reads and the exit value, so the command can be split without changing either. The
 * token file goes to a temp folder through KIT_MCP_TOKENS_DIR, never to ~/.kit.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdMcp } from "./mcp.js";
import { rmTemp } from "../temp-cleanup.test-support.js";

let dir: string;
let cwd: string;
let argv: string[];
let logs: string[];
let origLog: typeof console.log;
let origErr: typeof console.error;
const savedEnv = {
  tokens: process.env.KIT_MCP_TOKENS_DIR,
  probe: process.env.KIT_TEST_MCP_TOKEN,
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kit-mcp-cli-"));
  cwd = process.cwd();
  process.chdir(dir);
  process.env.KIT_MCP_TOKENS_DIR = join(dir, "tokens");
  delete process.env.KIT_TEST_MCP_TOKEN;
  argv = process.argv;
  logs = [];
  origLog = console.log;
  origErr = console.error;
  console.log = (...a: unknown[]) => void logs.push(a.join(" "));
  console.error = (...a: unknown[]) => void logs.push(a.join(" "));
});

afterEach(() => {
  process.chdir(cwd);
  process.argv = argv;
  console.log = origLog;
  console.error = origErr;
  for (const [key, value] of [
    ["KIT_MCP_TOKENS_DIR", savedEnv.tokens],
    ["KIT_TEST_MCP_TOKEN", savedEnv.probe],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmTemp(dir);
});

const run = async (...sub: string[]): Promise<{ ok: boolean; out: string }> => {
  process.argv = ["node", "kit", "mcp", ...sub];
  const ok = await cmdMcp();
  return { ok, out: logs.join("\n").replace(/\x1b\[[0-9;]*m/g, "") };
};
const declare = (): void =>
  writeFileSync(
    join(dir, ".kit.toml"),
    `[mcp.sentry]\nurl = "https://mcp.sentry.dev"\nscopes = ["org:read", "project:write"]\n`,
  );

describe("kit mcp list", () => {
  it("says when no [mcp.*] block is declared, and succeeds", async () => {
    const r = await run("list");
    assert.equal(r.ok, true);
    assert.match(r.out, /No \[mcp\.\*\] blocks declared in \.kit\.toml/);
  });

  it("shows a declared server without a token as missing, with its scopes, and succeeds", async () => {
    declare();
    const r = await run("status");
    assert.equal(r.ok, true);
    assert.match(r.out, /\? sentry\s+missing \[org:read, project:write\]/);
  });
});

describe("kit mcp auth", () => {
  it("needs a name", async () => {
    const r = await run("auth");
    assert.equal(r.ok, false);
    assert.match(r.out, /Usage: kit mcp auth <name>/);
  });

  it("refuses a name with no [mcp.<name>] block", async () => {
    const r = await run("auth", "sentry");
    assert.equal(r.ok, false);
    assert.match(r.out, /No \[mcp\.sentry\] block in \.kit\.toml/);
  });

  it("prints the vendor URL, the scopes and the two token options", async () => {
    declare();
    const r = await run("auth", "sentry");
    assert.equal(r.ok, true);
    assert.match(r.out, /Vendor URL: https:\/\/mcp\.sentry\.dev/);
    assert.match(r.out, /Required scopes: org:read, project:write/);
    assert.match(r.out, /kit mcp set-token sentry --from-env <VAR>/);
    assert.match(r.out, /kit mcp set-token sentry --paste/);
  });
});

describe("kit mcp set-token and clear", () => {
  it("needs a name, and either --from-env or --paste", async () => {
    assert.equal((await run("set-token")).ok, false);
    const r = await run("set-token", "sentry");
    assert.equal(r.ok, false);
    assert.match(r.out, /Missing --from-env <VAR> or --paste/);
  });

  it("refuses an empty environment variable and writes nothing", async () => {
    const r = await run("set-token", "sentry", "--from-env", "KIT_TEST_MCP_TOKEN");
    assert.equal(r.ok, false);
    assert.match(r.out, /Env var KIT_TEST_MCP_TOKEN is empty/);
    assert.equal(existsSync(join(dir, "tokens", "mcp-tokens.json")), false);
  });

  it("stores a token from the environment, reports the status, and clear removes it", async () => {
    declare();
    process.env.KIT_TEST_MCP_TOKEN = "tok-123";
    const stored = await run("set-token", "sentry", "--from-env", "KIT_TEST_MCP_TOKEN");
    assert.equal(stored.ok, true);
    assert.match(stored.out, /Token stored for sentry/);
    assert.match(stored.out, /Status: \w+/);
    assert.doesNotMatch(stored.out, /tok-123/);
    assert.equal(existsSync(join(dir, "tokens", "mcp-tokens.json")), true);
    logs.length = 0;
    assert.equal((await run("clear")).ok, false);
    logs.length = 0;
    const cleared = await run("clear", "sentry");
    assert.equal(cleared.ok, true);
    assert.match(cleared.out, /Cleared token for sentry/);
  });

  it("prints the usage for an unknown sub-command and fails", async () => {
    const r = await run("bogus");
    assert.equal(r.ok, false);
    assert.match(r.out, /Usage: kit mcp \[web \| list \| status/);
  });
});
