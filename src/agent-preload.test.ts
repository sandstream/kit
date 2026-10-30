import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditPreloadEnv, loadedByOptions, runAgentPreload } from "./agent-preload.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

describe("loadedByOptions", () => {
  it("reads the = form and the separate-argument form", () => {
    assert.deepEqual(loadedByOptions("--preload=/abs/a.js"), ["/abs/a.js"]);
    assert.deepEqual(loadedByOptions("--require ./b.cjs -r c.cjs"), ["./b.cjs", "c.cjs"]);
    assert.deepEqual(loadedByOptions("--import=tsx --experimental-loader ./l.mjs"), [
      "tsx",
      "./l.mjs",
    ]);
  });

  it("strips quotes around the value", () => {
    assert.deepEqual(loadedByOptions(`--preload="/abs/a.js"`), ["/abs/a.js"]);
    assert.deepEqual(loadedByOptions("--require 'x.js'"), ["x.js"]);
  });

  it("ignores options that load nothing", () => {
    assert.deepEqual(loadedByOptions("--max-old-space-size=4096 --enable-source-maps"), []);
    assert.deepEqual(loadedByOptions("--require"), []);
    assert.deepEqual(loadedByOptions(""), []);
  });
});

describe("auditPreloadEnv", () => {
  it("names each code-loading variable and what it loads", () => {
    const found = auditPreloadEnv({
      BUN_OPTIONS: "--preload=/abs/hook.js",
      NODE_OPTIONS: "--max-old-space-size=4096",
      LD_PRELOAD: "/lib/a.so:/lib/b.so",
      DYLD_INSERT_LIBRARIES: "/usr/lib/c.dylib",
      PATH: "/usr/bin",
    });
    assert.deepEqual(found, [
      { variable: "BUN_OPTIONS", loads: ["/abs/hook.js"] },
      { variable: "LD_PRELOAD", loads: ["/lib/a.so", "/lib/b.so"] },
      { variable: "DYLD_INSERT_LIBRARIES", loads: ["/usr/lib/c.dylib"] },
    ]);
  });

  it("finds nothing in a clean environment or a non-string value", () => {
    assert.deepEqual(auditPreloadEnv({ PATH: "/usr/bin", LD_PRELOAD: "" }), []);
    assert.deepEqual(auditPreloadEnv({ NODE_OPTIONS: 42 }), []);
  });
});

describe("runAgentPreload", () => {
  it("reports the process environment and every Claude settings env block", () => {
    const root = mkdtempSync(join(tmpdir(), "kit-preload-root-"));
    const home = mkdtempSync(join(tmpdir(), "kit-preload-home-"));
    try {
      mkdirSync(join(root, ".claude"));
      mkdirSync(join(home, ".claude"));
      writeFileSync(
        join(root, ".claude", "settings.json"),
        JSON.stringify({ env: { NODE_OPTIONS: "--require=./planted.cjs" } }),
      );
      writeFileSync(join(root, ".claude", "settings.local.json"), "{ not json");
      writeFileSync(
        join(home, ".claude", "settings.json"),
        JSON.stringify({ env: { BUN_OPTIONS: "--preload=/abs/hook.js" } }),
      );
      const rows = runAgentPreload(root, home, { LD_PRELOAD: "/lib/x.so" });
      assert.deepEqual(
        rows.map((r) => r.name),
        [
          "LD_PRELOAD loads code (process environment)",
          "NODE_OPTIONS loads code (.claude/settings.json)",
          "BUN_OPTIONS loads code (~/.claude/settings.json)",
        ],
      );
      assert.ok(rows.every((r) => r.status === "warn" && r.category === "exposure"));
      assert.match(rows[1].detail, /\.\/planted\.cjs/);
    } finally {
      rmTemp(root);
      rmTemp(home);
    }
  });

  it("reports a settings file once when run from the home directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-preload-same-"));
    try {
      mkdirSync(join(dir, ".claude"));
      writeFileSync(
        join(dir, ".claude", "settings.json"),
        JSON.stringify({ env: { BUN_OPTIONS: "--preload=/abs/hook.js" } }),
      );
      assert.equal(runAgentPreload(dir, dir, {}).length, 1);
    } finally {
      rmTemp(dir);
    }
  });

  it("returns no rows when nothing loads code", () => {
    const root = mkdtempSync(join(tmpdir(), "kit-preload-clean-"));
    try {
      assert.deepEqual(runAgentPreload(root, root, { PATH: "/usr/bin" }), []);
    } finally {
      rmTemp(root);
    }
  });
});
