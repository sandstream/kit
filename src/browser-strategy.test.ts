import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { diagnoseBrowser } from "./browser.js";
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

describe("browser strategy selection", () => {
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
          isExecutable: (path) => path.endsWith("/chromium-1234/chrome-linux/chrome"),
        },
        env: {},
        cwd: "/repo",
      },
    );
    assert.equal(result.status, "pass");
    assert.equal(result.strategy, "playwright");
    assert.equal(result.env.PLAYWRIGHT_BROWSERS_PATH, "/home/alice/.cache/ms-playwright");
  });

  it("does not accept a stale Chromium cache directory without an executable", async () => {
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
    assert.equal(result.status, "blocker");
    assert.equal(result.strategy, "none");
    assert.match(result.actions[0].command, /playwright install chromium/);
  });
});

describe("system Chrome selection", () => {
  it("selects system Chrome before CDP when no project Playwright is present", async () => {
    const result = await diagnoseBrowser(
      { port: 3107 },
      {
        deps: {
          ...noMachineDeps,
          findOnPath: () => "/usr/bin/google-chrome",
          isExecutable: (path) => path === "/usr/bin/google-chrome",
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

  it("rejects a directory and a non-executable chromium on PATH", async () => {
    const path = mkdtempSync(join(tmpdir(), "kit-browser-path-"));
    try {
      mkdirSync(join(path, "chromium"));
      writeFileSync(join(path, "google-chrome"), "#!/bin/sh\nexit 0\n");
      chmodSync(join(path, "google-chrome"), 0o644);
      const result = await diagnoseBrowser(
        { port: 3107 },
        {
          deps: { ...noMachineDeps, findOnPath: undefined, isExecutable: undefined },
          env: { PATH: path },
          cwd: "/repo",
        },
      );
      assert.equal(result.status, "blocker");
      assert.equal(result.strategy, "none");
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });
});

describe("system Chrome fallback", () => {
  it("rejects a non-executable macOS Chrome app path", async () => {
    const result = await diagnoseBrowser(
      { port: 3107 },
      {
        deps: {
          ...noMachineDeps,
          platform: "darwin",
          existsSync: (path) => path.endsWith("Google Chrome.app/Contents/MacOS/Google Chrome"),
        },
        env: {},
        cwd: "/repo",
      },
    );
    assert.equal(result.status, "blocker");
  });

  it("continues past an invalid PATH match to an executable Chrome", async () => {
    const root = mkdtempSync(join(tmpdir(), "kit-browser-path-"));
    const first = join(root, "first");
    const second = join(root, "second");
    try {
      mkdirSync(first);
      mkdirSync(second);
      writeFileSync(join(first, "google-chrome"), "#!/bin/sh\nexit 0\n", { mode: 0o644 });
      writeFileSync(join(second, "chromium"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const result = await diagnoseBrowser(
        { port: 3107 },
        {
          deps: { ...noMachineDeps, findOnPath: undefined, isExecutable: undefined },
          env: { PATH: `${first}${delimiter}${second}` },
          cwd: "/repo",
        },
      );
      assert.equal(result.status, "pass");
      assert.equal(result.strategy, "system-chrome");
      assert.equal(
        result.checks.find((check) => check.name === "system chrome")?.detail,
        join(second, "chromium"),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
