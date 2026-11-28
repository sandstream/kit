import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { governanceClient, governanceFixture } from "./governance-outcome.test-support.js";
import { injectRequested, mergeInjected, resolveInjectedSecrets } from "./run-inject.js";

const VALUE = "fixture-inject-value-4410";
const CONFIG = `[secrets]\nstore = "env"\n[secrets.keys.DEMO_INJECT]\nsource = "config"\nvalue = "${VALUE}"\n`;

describe("mergeInjected", () => {
  it("folds names case-insensitively on win32, so the child never gets both Path and PATH", () => {
    const env = mergeInjected(
      { Path: "inherited", OTHER: "kept" },
      new Map([["PATH", "x"]]),
      "win32",
    );
    assert.deepEqual(env, { OTHER: "kept", PATH: "x" });
  });

  it("keeps case-distinct names on POSIX, where they are different variables", () => {
    const env = mergeInjected({ Path: "inherited" }, new Map([["PATH", "x"]]), "linux");
    assert.deepEqual(env, { Path: "inherited", PATH: "x" });
  });

  it("lets the resolved value win over an inherited one of the same name", () => {
    assert.deepEqual(mergeInjected({ A: "old" }, new Map([["A", "new"]]), "darwin"), { A: "new" });
  });
});

describe("injectRequested", () => {
  it("reads only kit's own arguments", () => {
    assert.equal(injectRequested(["run", "--inject"]), true);
    assert.equal(injectRequested(["run"]), false);
  });
});

describe("resolveInjectedSecrets", () => {
  it("refuses a project that declares no [secrets.keys]", async (t) => {
    const { target } = governanceFixture(t);
    writeFileSync(join(target, ".kit.toml"), "version = 1\n");
    await assert.rejects(resolveInjectedSecrets(target), /declares no \[secrets\.keys\]/);
  });

  it("refuses a prod-scoped key outside prod before any read is recorded", async (t) => {
    const { target } = governanceFixture(t);
    writeFileSync(
      join(target, ".kit.toml"),
      `${CONFIG}[secrets.keys.DB_URL]\nsource = "config"\nvalue = "x"\nvault_path = "secret/prod/db"\n`,
    );
    await assert.rejects(resolveInjectedSecrets(target), /prod-scoped key\(s\) \(DB_URL\)/);
    const log = join(target, ".kit-audit.jsonl");
    assert.ok(!existsSync(log) || !readFileSync(log, "utf-8").includes("secrets.read"));
  });

  it("returns the resolved values and records the read via kit run", async (t) => {
    const { target } = governanceFixture(t);
    writeFileSync(join(target, ".kit.toml"), CONFIG);
    const resolved = await resolveInjectedSecrets(target);
    assert.equal(resolved.get("DEMO_INJECT"), VALUE);
    const log = readFileSync(join(target, ".kit-audit.jsonl"), "utf-8");
    assert.match(log, /"operation":"secrets\.read"/);
    assert.match(log, /"via":"kit run"/);
    assert.ok(!log.includes(VALUE));
  });
});

describe("MCP kit_run inject", () => {
  it("passes the declared secret to the command, redacted, and writes no .env.local", async (t) => {
    const { target } = governanceFixture(t);
    writeFileSync(join(target, ".kit.toml"), CONFIG);
    const script = join(target, "probe.cjs");
    writeFileSync(
      script,
      "const v = process.env.DEMO_INJECT; console.log('len=' + (v ? v.length : 'missing'), v);",
    );
    const client = await governanceClient(t);
    const call = (inject?: boolean) =>
      client.callTool({
        name: "kit_run",
        arguments: { cwd: target, command: `"${process.execPath}" "${script}"`, inject },
      });
    const injected = JSON.stringify((await call(true)).content);
    assert.match(injected, new RegExp(`len=${VALUE.length}`));
    assert.ok(!injected.includes(VALUE), injected);
    assert.equal(existsSync(join(target, ".env.local")), false);
    assert.match(JSON.stringify((await call()).content), /len=missing/);
  });
});
