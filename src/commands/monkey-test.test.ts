import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdMonkeyTest } from "./monkey-test.js";

let dir: string;
let cwd: string;
let argv: string[];
let exitCode: string | number | null | undefined;
let logs: string[];
let origLog: typeof console.log;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kit-monkey-cmd-"));
  cwd = process.cwd();
  process.chdir(dir);
  argv = process.argv;
  exitCode = process.exitCode;
  logs = [];
  origLog = console.log;
  console.log = (...args: unknown[]) => void logs.push(args.join(" "));
});

afterEach(() => {
  process.chdir(cwd);
  process.argv = argv;
  process.exitCode = exitCode;
  console.log = origLog;
  rmSync(dir, { recursive: true, force: true });
});

function setArgs(...args: string[]): void {
  process.argv = ["node", "kit", "monkey-test", ...args];
}

function writePackage(value: unknown): void {
  writeFileSync(join(dir, "package.json"), JSON.stringify(value, null, 2) + "\n");
}

function outputJson<T>(): T {
  return JSON.parse(logs.join("\n")) as T;
}

describe("cmdMonkeyTest", () => {
  it("plan --json reports the role matrix and returns true when no required runner check fails", async () => {
    writePackage({
      scripts: { dev: "vite --host 127.0.0.1" },
      devDependencies: { "@playwright/test": "1.0.0" },
    });
    setArgs("plan", "--json");

    assert.equal(await cmdMonkeyTest(), true);
    const plan = outputJson<{ roles: { id: string; label: string }[] }>();

    assert.ok(plan.roles.some((role) => role.id === "staff" && role.label === "Kiosk staff"));
  });

  it("init --json creates the managed Playwright harness", async () => {
    setArgs("init", "--json");

    assert.equal(await cmdMonkeyTest(), true);
    const result = outputJson<{ ok: boolean; writes: { action: string }[] }>();

    assert.equal(result.ok, true);
    assert.ok(result.writes.every((write) => write.action === "created"));
    assert.equal(existsSync(join(dir, "playwright.monkey.config.ts")), true);
    assert.equal(existsSync(join(dir, "tests", "monkey", "monkey.spec.ts")), true);
  });

  it("run --skip-browser needs an expected reason and can return a structured skipped run", async () => {
    writePackage({ scripts: {} });
    setArgs("run", "--skip-browser", "--expected", "browser is covered by release smoke", "--json");

    assert.equal(await cmdMonkeyTest(), true);
    const result = outputJson<{ ok: boolean; steps: { name: string; status: string }[] }>();

    assert.equal(result.ok, true);
    assert.ok(result.steps.some((step) => step.name === "browser" && step.status === "skip"));
  });

  it("rejects an unknown subcommand and prints usage", async () => {
    setArgs("nope");

    assert.equal(await cmdMonkeyTest(), false);
    assert.equal(process.exitCode, 1);
    assert.match(logs.join("\n"), /kit monkey-test/);
  });
});
