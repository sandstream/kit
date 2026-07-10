import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdTriage } from "./triage.js";

// Only the honest-skip path of `kit triage plugin` is exercised here — the happy path calls the
// live npm registry triage (network), which is out of scope for a unit test.
describe("kit triage plugin (no plugins declared → honest skip)", () => {
  let dir: string;
  let cwd: string;
  let argv: string[];
  let logs: string[];
  let origLog: typeof console.log;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kit-triage-plugin-"));
    cwd = process.cwd();
    process.chdir(dir);
    argv = process.argv;
    logs = [];
    origLog = console.log;
    console.log = (...a: unknown[]) => void logs.push(a.join(" "));
  });

  afterEach(() => {
    process.chdir(cwd);
    process.argv = argv;
    console.log = origLog;
    rmSync(dir, { recursive: true, force: true });
  });

  it("skips cleanly (exit 0) when package.json has no kitPlugins", async () => {
    process.argv = ["node", "kit", "triage", "plugin"];
    const ok = await cmdTriage();
    assert.equal(ok, true);
    assert.match(logs.join("\n"), /no kitPlugins declared/);
  });
});
