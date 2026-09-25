import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  homedir: () => mockHome,
  platform: "linux",
};

const mockRepo = join(tmpdir(), "kit-browser-mock-repo");
const mockHome = join(tmpdir(), "kit-browser-mock-home");
const mockCache = join(mockHome, ".cache", "ms-playwright");

describe("browser strategy selection", () => {
  it("blocks when Playwright exists but its browser cache is missing", async () => {
    const exists = new Set([join(mockRepo, "node_modules", "@playwright", "test", "package.json")]);
    const result = await diagnoseBrowser(
      { port: 3107, routes: "e2e/routes.spec.ts" },
      {
        deps: { ...noMachineDeps, existsSync: (path) => exists.has(path) },
        env: {},
        cwd: mockRepo,
      },
    );
    assert.equal(result.status, "blocker");
    assert.equal(result.strategy, "none");
    assert.match(result.actions[0].command, /npx playwright install chromium/);
  });

  it("selects Playwright when package and Chromium cache are present", async () => {
    const exists = new Set([
      join(mockRepo, "node_modules", "@playwright", "test", "package.json"),
      mockCache,
    ]);
    const result = await diagnoseBrowser(
      { port: 3107, routes: "e2e/routes.spec.ts" },
      {
        deps: {
          ...noMachineDeps,
          existsSync: (path) => exists.has(path),
          readdirSync: () => ["chromium-1234"],
          isExecutable: (path) =>
            path === join(mockCache, "chromium-1234", "chrome-linux", "chrome"),
        },
        env: {},
        cwd: mockRepo,
      },
    );
    assert.equal(result.status, "pass");
    assert.equal(result.strategy, "playwright");
    assert.equal(result.env.PLAYWRIGHT_BROWSERS_PATH, mockCache);
  });

  it("does not accept a stale Chromium cache directory without an executable", async () => {
    const exists = new Set([
      join(mockRepo, "node_modules", "@playwright", "test", "package.json"),
      mockCache,
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
        cwd: mockRepo,
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
      const directory = process.platform === "win32" ? "chromium.exe" : "chromium";
      const invalid = process.platform === "win32" ? "google-chrome.exe" : "google-chrome";
      mkdirSync(join(path, directory));
      writeFileSync(join(path, invalid), "#!/bin/sh\nexit 0\n");
      chmodSync(join(path, invalid), 0o644);
      const result = await diagnoseBrowser(
        { port: 3107 },
        {
          deps: {
            ...noMachineDeps,
            platform: process.platform === "win32" ? "win32" : "linux",
            findOnPath: undefined,
            isExecutable: undefined,
          },
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
      const invalid = process.platform === "win32" ? "google-chrome.exe" : "google-chrome";
      const valid = process.platform === "win32" ? "chromium.exe" : "chromium";
      writeFileSync(join(first, invalid), "#!/bin/sh\nexit 0\n", { mode: 0o644 });
      if (process.platform === "win32") {
        try {
          linkSync(process.execPath, join(second, valid));
        } catch {
          copyFileSync(process.execPath, join(second, valid));
        }
      } else {
        writeFileSync(join(second, valid), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      }
      const result = await diagnoseBrowser(
        { port: 3107 },
        {
          deps: {
            ...noMachineDeps,
            platform: process.platform === "win32" ? "win32" : "linux",
            findOnPath: undefined,
            isExecutable: undefined,
          },
          env: { PATH: `${first}${delimiter}${second}` },
          cwd: "/repo",
        },
      );
      assert.equal(result.status, "pass");
      assert.equal(result.strategy, "system-chrome");
      assert.equal(
        result.checks.find((check) => check.name === "system chrome")?.detail,
        join(second, valid),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
