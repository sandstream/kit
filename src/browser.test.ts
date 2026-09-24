import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { diagnoseBrowser, resolveBrowserCdpUrl } from "./browser.js";
import type { BrowserProbeDeps } from "./browser.js";

const noMachineDeps: BrowserProbeDeps = {
  existsSync: () => false,
  readdirSync: () => [],
  isExecutable: () => false,
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
        env: { KIT_BROWSER_CDP_URL: "http://127.0.0.1:9333" },
        cwd: "/repo",
      },
    );
    assert.equal(result.status, "pass");
    assert.equal(result.strategy, "cdp");
    assert.deepEqual(urls, ["http://127.0.0.1:9333/json/version"]);
    assert.equal(result.cdp_url, "http://127.0.0.1:9333");
    assert.equal(result.env.KIT_BROWSER_CDP_URL, "http://127.0.0.1:9333");
  });

  it("refuses credential-bearing CDP URLs before probing or exposing them", async () => {
    const probes: string[] = [];
    const secretUrl = "http://operator:private-secret@127.0.0.1:9333";
    const options = {
      deps: {
        ...noMachineDeps,
        probeUrl: async (url: string) => {
          probes.push(url);
          return url.startsWith(secretUrl);
        },
      },
      env: { KIT_BROWSER_CDP_URL: secretUrl },
      cwd: "/repo",
    };
    const result = await diagnoseBrowser({ port: 3107 }, options);
    assert.equal(result.status, "blocker");
    assert.equal(result.cdp_url, undefined);
    assert.equal(await resolveBrowserCdpUrl({ port: 3107 }, options), undefined);
    assert.ok(!JSON.stringify(result).includes("private-secret"));
    assert.ok(probes.every((url) => !url.includes("private-secret")));
  });

  it("blocks instead of exporting an unreachable configured CDP URL", async () => {
    const urls: string[] = [];
    const result = await diagnoseBrowser(
      { port: 3107, cdp_url: "http://127.0.0.1:9/not-listening" },
      {
        deps: {
          ...noMachineDeps,
          probeUrl: async (url) => {
            urls.push(url);
            return false;
          },
        },
        env: {},
        cwd: "/repo",
      },
    );
    assert.equal(result.status, "blocker");
    assert.equal(result.strategy, "none");
    assert.equal(result.env.KIT_BROWSER_CDP_URL, undefined);
    assert.deepEqual(urls, [
      "http://127.0.0.1:9/not-listening/json/version",
      "http://127.0.0.1:9222/json/version",
    ]);
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
});
