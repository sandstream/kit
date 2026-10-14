import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import {
  describeDesktopApp,
  detectDesktopApp,
  platformDataDirs,
} from "./monkey-test-desktop-detect.js";

async function inRepo(
  files: Record<string, string>,
  body: (root: string) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "kit-desktop-detect-"));
  try {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    await body(root);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

it("lists the macOS data folder for each name", () => {
  assert.deepEqual(platformDataDirs(["com.x.app"], "darwin", "/Users/a", {}), [
    join("/Users/a", "Library", "Application Support", "com.x.app"),
  ]);
});

it("lists both Windows data roots, honouring APPDATA and LOCALAPPDATA", () => {
  const dirs = platformDataDirs(["App"], "win32", "C:\\Users\\a", {
    APPDATA: "R",
    LOCALAPPDATA: "L",
  });
  assert.deepEqual(dirs, [join("R", "App"), join("L", "App")]);
});

it("lists XDG data and config roots on Linux, and de-duplicates repeated names", () => {
  const dirs = platformDataDirs(["a", "a"], "linux", "/home/u", {});
  assert.deepEqual(dirs, [
    join("/home/u", ".local", "share", "a"),
    join("/home/u", ".config", "a"),
  ]);
});

it("detects Tauri 2 from tauri.conf.json and keeps only an http dev URL", () =>
  inRepo(
    {
      "src-tauri/tauri.conf.json": JSON.stringify({
        productName: "Notes",
        identifier: "com.example.notes",
        build: { devUrl: "http://localhost:1420" },
      }),
    },
    async (root) => {
      const app = await detectDesktopApp(root, {});
      assert.equal(app?.framework, "tauri");
      assert.equal(app?.config, "src-tauri/tauri.conf.json");
      assert.equal(app?.identifier, "com.example.notes");
      assert.equal(app?.productName, "Notes");
      assert.equal(app?.devUrl, "http://localhost:1420");
      assert.ok(app?.drivers.includes("eval-hook"));
      assert.ok((app?.realDataDirs.length ?? 0) > 0);
    },
  ));

it("reads a Tauri 1 JSON5 config with comments and trailing commas", () =>
  inRepo(
    {
      "src-tauri/tauri.conf.json5": `{
  // identity
  "package": { "productName": "Legacy", },
  "tauri": { "bundle": { "identifier": "com.example.legacy", }, },
}`,
    },
    async (root) => {
      const app = await detectDesktopApp(root, {});
      assert.equal(app?.productName, "Legacy");
      assert.equal(app?.identifier, "com.example.legacy");
    },
  ));

it("reads Tauri.toml", () =>
  inRepo(
    { "src-tauri/Tauri.toml": 'productName = "Toml"\nidentifier = "com.example.toml"\n' },
    async (root) => {
      const app = await detectDesktopApp(root, {});
      assert.equal(app?.identifier, "com.example.toml");
    },
  ));

it("reports a Tauri app without identity when its config does not parse", () =>
  inRepo({ "src-tauri/tauri.conf.json": "{ not json" }, async (root) => {
    const app = await detectDesktopApp(root, {});
    assert.equal(app?.framework, "tauri");
    assert.equal(app?.identifier, undefined);
    assert.deepEqual(app?.realDataDirs, []);
  }));

it("detects Tauri from a dependency alone, with package.json as the config", () =>
  inRepo({}, async (root) => {
    const app = await detectDesktopApp(root, { dependencies: { "@tauri-apps/api": "^2" } });
    assert.equal(app?.framework, "tauri");
    assert.equal(app?.config, "package.json");
  }));

it("detects Electron and prefers build.productName for the data folder name", () =>
  inRepo({}, async (root) => {
    const app = await detectDesktopApp(root, {
      name: "pkg-name",
      devDependencies: { electron: "^30" },
      build: { appId: "com.example.e", productName: "Shown" },
    } as never);
    assert.equal(app?.framework, "electron");
    assert.equal(app?.identifier, "com.example.e");
    assert.equal(app?.productName, "Shown");
    assert.deepEqual(app?.drivers, ["playwright-electron", "eval-hook"]);
  }));

it("returns null for a plain web project", () =>
  inRepo({}, async (root) => {
    assert.equal(await detectDesktopApp(root, { dependencies: { react: "^18" } }), null);
  }));

it("describes the app by identity, config and drivers", () => {
  const text = describeDesktopApp({
    framework: "tauri",
    config: "src-tauri/tauri.conf.json",
    identifier: "com.example.notes",
    realDataDirs: [],
    drivers: ["eval-hook"],
  });
  assert.equal(
    text,
    "Tauri app com.example.notes (src-tauri/tauri.conf.json); drive with eval-hook",
  );
});
