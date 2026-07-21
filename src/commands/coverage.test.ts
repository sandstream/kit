import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdCoverage } from "./coverage.js";

let dir: string;
let cwd0: string;
let argv0: string[];
let logs: string[];
let origLog: typeof console.log;
let origErr: typeof console.error;
let exitCode0: typeof process.exitCode;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kit-coverage-cmd-"));
  cwd0 = process.cwd();
  process.chdir(dir);
  argv0 = process.argv;
  exitCode0 = process.exitCode;
  logs = [];
  origLog = console.log;
  origErr = console.error;
  console.log = (...a: unknown[]) => void logs.push(a.join(" "));
  console.error = (...a: unknown[]) => void logs.push(a.join(" "));
});

afterEach(() => {
  process.chdir(cwd0);
  process.argv = argv0;
  process.exitCode = exitCode0;
  console.log = origLog;
  console.error = origErr;
  rmSync(dir, { recursive: true, force: true });
});

const setArgs = (...flags: string[]): void => {
  process.argv = ["node", "kit", "coverage", ...flags];
};
const out = (): string => logs.join("\n");

describe("kit coverage — registry-driven standards", () => {
  it("--list-standards enumerates all five, marked on by default", async () => {
    setArgs("--list-standards");
    assert.equal(await cmdCoverage(), true);
    const text = out();
    for (const key of ["asvs", "llm-top10", "ssdf", "agentic-top10", "mcp-top10"]) {
      assert.match(text, new RegExp(key), `lists ${key}`);
    }
    assert.match(text, /on /); // no toggle ⇒ enabled
  });

  it("--standard=agentic-top10 renders the OWASP Agentic map (ASI01)", async () => {
    setArgs("--standard=agentic-top10");
    assert.equal(await cmdCoverage(), true);
    const text = out();
    assert.match(text, /Agentic Applications/);
    assert.match(text, /ASI01/);
    assert.match(text, /evidence map, not a compliance attestation/i);
  });

  it("--standard=mcp-top10 --json emits a structured MCP report", async () => {
    setArgs("--standard=mcp-top10", "--json");
    assert.equal(await cmdCoverage(), true);
    const report = JSON.parse(out());
    assert.equal(report.key, "mcp-top10");
    assert.equal(report.summary.total, 10);
  });

  it("--standard=all --json keys the output by every enabled standard", async () => {
    setArgs("--standard=all", "--json");
    assert.equal(await cmdCoverage(), true);
    const obj = JSON.parse(out());
    for (const key of ["asvs", "llm-top10", "ssdf", "agentic-top10", "mcp-top10"]) {
      assert.ok(key in obj, `all-report includes ${key}`);
    }
  });

  it("an unknown --standard fails and lists the valid keys", async () => {
    setArgs("--standard=bogus");
    assert.equal(await cmdCoverage(), false);
    assert.match(out(), /unknown --standard 'bogus'/);
    assert.match(out(), /agentic-top10/);
  });

  it("[coverage].standards toggles a standard off → selecting it fails", async () => {
    writeFileSync(join(dir, ".kit.toml"), `[coverage]\nstandards = ["asvs"]\n`, "utf-8");
    setArgs("--standard=mcp-top10");
    assert.equal(await cmdCoverage(), false);
    assert.match(out(), /disabled in \[coverage\]\.standards/);
  });

  it("[coverage].standards toggle → --list-standards marks the excluded ones off", async () => {
    writeFileSync(join(dir, ".kit.toml"), `[coverage]\nstandards = ["asvs"]\n`, "utf-8");
    setArgs("--list-standards");
    assert.equal(await cmdCoverage(), true);
    // strip ANSI so the on/off tag matches regardless of color codes
    const text = out().replace(/\x1B\[[0-9;]*m/g, "");
    // asvs on, mcp-top10 off
    assert.match(text, /on\s+asvs/);
    assert.match(text, /off\s+mcp-top10/);
  });
});
