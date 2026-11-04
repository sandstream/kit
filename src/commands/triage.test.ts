import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdTriage } from "./triage.js";
import { installBundledTriageSkill } from "../triage.js";
import { rmTemp } from "../temp-cleanup.test-support.js";

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
    rmTemp(dir);
  });

  it("skips cleanly (exit 0) when package.json has no kitPlugins", async () => {
    process.argv = ["node", "kit", "triage", "plugin"];
    const ok = await cmdTriage();
    assert.equal(ok, true);
    assert.match(logs.join("\n"), /no kitPlugins declared/);
  });
});

// RED-1: `kit triage <type> <target>` echoes the target back before running the
// real probe. A target can legitimately carry a credential (`kit triage repo
// https://u:ghp_xxx@host/owner/repo`), so that echo must not leak it.
describe("kit triage <type> <target> never echoes an embedded credential (RED-1)", () => {
  let dir: string;
  let cwd: string;
  let argv: string[];
  let logs: string[];
  let origLog: typeof console.log;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kit-triage-redact-"));
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
    rmTemp(dir);
  });

  it("does not print the token embedded in a `triage repo` target", async () => {
    // Force-refresh the installed skill copy from THIS checkout: ensureTriageScript()
    // only refreshes on a kit-version mismatch, so a same-version, mid-development edit
    // to the bundled triage.py (this fix, pre-release) would otherwise silently run
    // whatever was already installed on the machine running the test.
    await installBundledTriageSkill();
    const token = `ghp_${"A".repeat(40)}`;
    process.argv = [
      "node",
      "kit",
      "triage",
      "repo",
      `https://u:${token}@github.com/nonexistent-owner-1234/nonexistent-repo-5678`,
    ];
    await cmdTriage();
    const output = logs.join("\n");
    assert.match(output, /Running triage on repo/);
    assert.ok(!output.includes(token), `output must not leak the token: ${output}`);
  });
});
