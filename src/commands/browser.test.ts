import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdBrowser } from "./browser.js";

let dir: string;
let cwd: string;
let argv: string[];
let logs: string[];
let errs: string[];
let origLog: typeof console.log;
let origErr: typeof console.error;
let origPath: string | undefined;
let servers: Server[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kit-browser-cmd-"));
  cwd = process.cwd();
  process.chdir(dir);
  argv = process.argv;
  logs = [];
  errs = [];
  origLog = console.log;
  origErr = console.error;
  origPath = process.env.PATH;
  process.env.PATH = "";
  servers = [];
  console.log = (...a: unknown[]) => void logs.push(a.join(" "));
  console.error = (...a: unknown[]) => void errs.push(a.join(" "));
});

afterEach(async () => {
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  process.chdir(cwd);
  process.argv = argv;
  process.env.PATH = origPath;
  console.log = origLog;
  console.error = origErr;
  rmSync(dir, { recursive: true, force: true });
});

function setArgs(...sub: string[]): void {
  process.argv = ["node", "kit", "browser", ...sub];
}

async function writeReachableCdpConfig(): Promise<string> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"Browser":"test"}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;
  writeFileSync(join(dir, ".kit.toml"), `[browser]\nport = 3107\ncdp_url = "${url}"\n`, "utf-8");
  return url;
}

describe("cmdBrowser", () => {
  it("doctor --json emits the stable diagnostic shape", async () => {
    setArgs("doctor", "--json");
    assert.equal(await cmdBrowser(), true);
    const out = JSON.parse(logs.join("\n"));
    assert.equal(out.status, "skip");
    assert.equal(out.strategy, "none");
    assert.ok(Array.isArray(out.checks));
    assert.ok(Array.isArray(out.actions));
    assert.equal(out.env.KIT_BROWSER_STRATEGY, "none");
  });

  it("cdp-url prints configured URL from [browser]", async () => {
    const url = await writeReachableCdpConfig();
    setArgs("cdp-url");
    assert.equal(await cmdBrowser(), true);
    assert.equal(logs.join("\n"), url);
    assert.equal(errs.join("\n"), "");
  });

  it("cdp-url --json keeps cdp_url present when none is detected", async () => {
    setArgs("cdp-url", "--json");
    assert.equal(await cmdBrowser(), false);
    const out = JSON.parse(logs.join("\n"));
    assert.equal(out.cdp_url, null);
    assert.equal(out.strategy, "none");
  });

  it("playwright-env prints shell exports", async () => {
    const url = await writeReachableCdpConfig();
    setArgs("playwright-env");
    assert.equal(await cmdBrowser(), true);
    assert.match(logs.join("\n"), /export KIT_BROWSER_STRATEGY='[^']+'/);
    assert.match(logs.join("\n"), new RegExp(`export KIT_BROWSER_CDP_URL='${url}'`));
  });
});
