import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkStandardsMjsPlugins,
  runMjsPlugins,
  collectMjsPluginKeys,
} from "./standards-plugins-exec.js";
import { DEFAULT_PLUGIN_DIR, pluginKey } from "./standards-plugins.js";

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "kit-mjs-"));
}
function writeMjs(repo: string, name: string, body: string): void {
  const dir = join(repo, DEFAULT_PLUGIN_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), body);
}

describe("standards-plugins-exec — programmatic mjs (restricted child)", () => {
  it("runs a deterministic plugin and surfaces its findings (net-new gated)", async () => {
    const repo = tmpRepo();
    try {
      writeMjs(
        repo,
        "p.mjs",
        `export const id = "my-rule";
export const title = "My rule";
export function evaluate(ctx) {
  return { findings: [{ file: "src/a.ts", line: 5, message: "nope" }] };
}`,
      );
      const r = await checkStandardsMjsPlugins({
        cwd: repo,
        language: "typescript",
        enforce: false,
        dirs: [DEFAULT_PLUGIN_DIR],
      });
      assert.equal(r.length, 1);
      assert.equal(r[0].name, "plugin: my-rule");
      assert.equal(r[0].status, "warn");
      assert.match(r[0].files?.[0] ?? "", /src\/a\.ts:5/);

      // baseline the finding → frozen low warn
      const frozen = await checkStandardsMjsPlugins({
        cwd: repo,
        language: "typescript",
        dirs: [DEFAULT_PLUGIN_DIR],
        baseline: [pluginKey("my-rule", "src/a.ts", 5)],
      });
      assert.equal(frozen[0].status, "warn");
      assert.equal(frozen[0].severity, "low");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("severity=fail makes net-new findings fail without --enforce", async () => {
    const repo = tmpRepo();
    try {
      writeMjs(
        repo,
        "p.mjs",
        `export function evaluate() {
  return { id: "hard", title: "Hard rule", severity: "fail", findings: [{ file: "x.ts", line: 1 }] };
}`,
      );
      const r = await checkStandardsMjsPlugins({
        cwd: repo,
        language: "typescript",
        dirs: [DEFAULT_PLUGIN_DIR],
      });
      assert.equal(r[0].status, "fail");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("REJECTS a non-deterministic plugin (two runs differ → integrity warn)", async () => {
    const repo = tmpRepo();
    try {
      writeMjs(
        repo,
        "flaky.mjs",
        `export function evaluate() {
  const n = Math.floor(Math.random() * 1e9);
  return { id: "flaky", title: "Flaky", findings: [{ file: "f.ts", line: n }] };
}`,
      );
      const runs = await runMjsPlugins(repo, [DEFAULT_PLUGIN_DIR], "typescript");
      assert.equal(runs.length, 1);
      assert.ok(runs[0].integrity, "flaky plugin flagged as integrity failure");
      assert.match(runs[0].integrity?.detail ?? "", /non-deterministic/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("runs with a STRIPPED env — the plugin cannot see a secret var", async () => {
    const repo = tmpRepo();
    const prev = process.env.KIT_MEMORY_PASSPHRASE;
    process.env.KIT_MEMORY_PASSPHRASE = "super-secret-value-xyz";
    try {
      writeMjs(
        repo,
        "leak.mjs",
        `export function evaluate() {
  const leaked = process.env.KIT_MEMORY_PASSPHRASE ? "LEAKED" : "clean";
  return { id: "envcheck", title: "env check", findings: [{ file: leaked + ".ts", line: 1 }] };
}`,
      );
      const r = await checkStandardsMjsPlugins({
        cwd: repo,
        language: "typescript",
        dirs: [DEFAULT_PLUGIN_DIR],
      });
      // the child never saw the secret → filename encodes "clean", never "LEAKED"
      assert.match(r[0].files?.[0] ?? "", /clean\.ts/);
      assert.doesNotMatch(r[0].files?.[0] ?? "", /LEAKED/);
    } finally {
      if (prev === undefined) delete process.env.KIT_MEMORY_PASSPHRASE;
      else process.env.KIT_MEMORY_PASSPHRASE = prev;
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("fails closed on malformed output (schema) and on a missing evaluate export", async () => {
    const repo = tmpRepo();
    try {
      writeMjs(
        repo,
        "bad.mjs",
        `export function evaluate() { return { findings: "not-an-array" }; }`,
      );
      writeMjs(repo, "noeval.mjs", `export const notEvaluate = 1;`);
      const runs = await runMjsPlugins(repo, [DEFAULT_PLUGIN_DIR], "typescript");
      assert.equal(runs.length, 2);
      assert.ok(
        runs.every((run) => run.integrity),
        "both flagged as integrity failures",
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("applies_to filters by language; collectMjsPluginKeys snapshots matches", async () => {
    const repo = tmpRepo();
    try {
      writeMjs(
        repo,
        "py.mjs",
        `export function evaluate() {
  return { id: "py-only", title: "py", appliesTo: ["python"], findings: [{ file: "a.py", line: 3 }] };
}`,
      );
      const filtered = await checkStandardsMjsPlugins({
        cwd: repo,
        language: "typescript",
        dirs: [DEFAULT_PLUGIN_DIR],
      });
      assert.equal(filtered.length, 0); // applies_to excludes typescript

      const keys = await collectMjsPluginKeys(repo, "python", [DEFAULT_PLUGIN_DIR]);
      assert.deepEqual(keys, [pluginKey("py-only", "a.py", 3)]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
