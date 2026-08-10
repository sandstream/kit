import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { diagnoseBrowser } from "./browser.js";
import type { BrowserProbeDeps } from "./browser.js";

const noMachineDeps: BrowserProbeDeps = {
  existsSync: () => false,
  readdirSync: () => [],
  findOnPath: () => undefined,
  probeUrl: async () => false,
  homedir: () => "/home/alice",
  platform: "linux",
};

describe("browser diagnostics", () => {
  it("skips honestly when no [browser] config is declared", async () => {
    const result = await diagnoseBrowser(undefined, { deps: noMachineDeps, env: {}, cwd: "/repo" });
    assert.equal(result.status, "skip");
    assert.equal(result.strategy, "none");
    assert.equal(result.env.KIT_BROWSER_STRATEGY, "none");
    assert.equal(result.checks[0].name, "browser config");
  });

  it("fails declared browser config without an app-server port", async () => {
    const result = await diagnoseBrowser(
      { routes: "e2e/routes.spec.ts" },
      { deps: noMachineDeps, env: {}, cwd: "/repo" },
    );
    assert.equal(result.status, "fail");
    assert.equal(result.strategy, "none");
    assert.match(result.checks.map((check) => check.name).join(","), /app port/);
    assert.match(result.actions[0].command, /port = 3107/);
  });

  it("uses KIT_BROWSER_CDP_URL when no Playwright or system Chrome path exists", async () => {
    const result = await diagnoseBrowser(
      { port: 3107 },
      { deps: noMachineDeps, env: { KIT_BROWSER_CDP_URL: "http://127.0.0.1:9333" }, cwd: "/repo" },
    );
    assert.equal(result.status, "pass");
    assert.equal(result.strategy, "cdp");
    assert.equal(result.cdp_url, "http://127.0.0.1:9333");
    assert.equal(result.env.KIT_BROWSER_CDP_URL, "http://127.0.0.1:9333");
  });

  it("probes localhost 9222 as the last CDP source", async () => {
    const urls: string[] = [];
    const result = await diagnoseBrowser(
      { port: 3107 },
      {
        deps: {
          ...noMachineDeps,
          probeUrl: async (url) => {
            urls.push(url);
            return true;
          },
        },
        env: {},
        cwd: "/repo",
      },
    );
    assert.equal(result.status, "pass");
    assert.equal(result.strategy, "cdp");
    assert.deepEqual(urls, ["http://127.0.0.1:9222/json/version"]);
    assert.equal(result.cdp_url, "http://127.0.0.1:9222");
  });

  it("blocks when Playwright exists but its browser cache is missing", async () => {
    const exists = new Set(["/repo/node_modules/@playwright/test/package.json"]);
    const result = await diagnoseBrowser(
      { port: 3107, routes: "e2e/routes.spec.ts" },
      {
        deps: { ...noMachineDeps, existsSync: (path) => exists.has(path) },
        env: {},
        cwd: "/repo",
      },
    );
    assert.equal(result.status, "blocker");
    assert.equal(result.strategy, "none");
    assert.match(result.actions[0].command, /npx playwright install chromium/);
  });

  it("selects Playwright when package and Chromium cache are present", async () => {
    const exists = new Set([
      "/repo/node_modules/@playwright/test/package.json",
      "/home/alice/.cache/ms-playwright",
    ]);
    const result = await diagnoseBrowser(
      { port: 3107, routes: "e2e/routes.spec.ts" },
      {
        deps: {
          ...noMachineDeps,
          existsSync: (path) => exists.has(path),
          readdirSync: () => ["chromium-1234"],
        },
        env: {},
        cwd: "/repo",
      },
    );
    assert.equal(result.status, "pass");
    assert.equal(result.strategy, "playwright");
    assert.equal(result.env.PLAYWRIGHT_BROWSERS_PATH, "/home/alice/.cache/ms-playwright");
  });

  it("selects system Chrome before CDP when no project Playwright is present", async () => {
    const result = await diagnoseBrowser(
      { port: 3107 },
      {
        deps: {
          ...noMachineDeps,
          findOnPath: () => "/usr/bin/google-chrome",
          probeUrl: async () => true,
        },
        env: {},
        cwd: "/repo",
      },
    );
    assert.equal(result.status, "pass");
    assert.equal(result.strategy, "system-chrome");
    assert.equal(result.cdp_url, undefined);
  });
});
