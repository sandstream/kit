/**
 * `kit run --inject` hands declared secrets to one child through its environment and writes no
 * `.env.local`; `kit secrets` keeps writing the file in 7.x and says, once, on stderr, that 8.0
 * stops doing so unless it is given `--write-env-file` (docs/plans/2026-11-27-secrets-exec-inject.md).
 *
 * Why an injected value is enough for the two dev servers the plan names, from their own docs:
 * - Next.js: "process.env", then ".env.$(NODE_ENV).local", then ".env.local" —
 *   https://nextjs.org/docs/app/guides/environment-variables#environment-variable-load-order
 * - Vite: "environment variables that already exist when Vite is executed have the highest
 *   priority and will not be overwritten by .env files" — https://vite.dev/guide/env-and-mode
 * So the child below stands in for `next dev` / `vite`: it reads `process.env`, never the file.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { createCliContractFixture } from "./cli-contract.test-support.js";

const VALUE = "fixture-inject-value-7731";
const CONFIG = `[secrets]\nstore = "env"\n[secrets.keys.DEMO_INJECT]\nsource = "config"\nvalue = "${VALUE}"\n`;
const NOTICE = /kit 8 will stop writing \.env\.local by default.*kit run --inject/;

/** A child that reports what it was handed, and echoes the value so redaction is visible. */
const PROBE = [
  "const v = process.env.DEMO_INJECT;",
  "console.log('len=' + (v ? v.length : 'missing'));",
  "console.log('file=' + (process.env.ONLY_IN_FILE ?? 'unset'));",
  "console.log('echo=' + v);",
].join(" ");

function fixture(t: TestContext, config = CONFIG) {
  const f = createCliContractFixture(config);
  t.after(() => f.cleanup());
  return f;
}

function readEvents(cwd: string): { operation: string; metadata?: Record<string, unknown> }[] {
  const log = readFileSync(join(cwd, ".kit-audit.jsonl"), "utf-8");
  assert.ok(!log.includes(VALUE), "the audit log must never hold a value");
  return log
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { operation: string; metadata?: Record<string, unknown> });
}

describe("kit run --inject", () => {
  it("passes a declared secret only in the child's environment, recorded and redacted", (t) => {
    const f = fixture(t);
    const result = f.run(["run", "--inject", "--", process.execPath, "-e", PROBE]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`len=${VALUE.length}`));
    assert.ok(!result.stdout.includes(VALUE), `child output must be redacted:\n${result.stdout}`);
    assert.equal(existsSync(join(f.cwd, ".env.local")), false, "--inject must not write the file");
    const read = readEvents(f.cwd).filter((e) => e.operation === "secrets.read");
    assert.equal(read.length, 1, JSON.stringify(read));
    assert.equal(read[0]!.metadata?.via, "kit run");
    assert.equal(read[0]!.metadata?.store, "config");
    assert.equal(read[0]!.metadata?.name, "DEMO_INJECT");
  });

  it("never reads a stale .env.local", (t) => {
    const f = fixture(t);
    writeFileSync(join(f.cwd, ".env.local"), "DEMO_INJECT=stale-file-value\nONLY_IN_FILE=x\n");
    const result = f.run(["run", "--inject", "--", process.execPath, "-e", PROBE]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`len=${VALUE.length}`));
    assert.match(result.stdout, /file=unset/);
    assert.ok(!result.stdout.includes("stale-file-value"));
  });

  it("does not start the child when a declared secret cannot be resolved (fail closed)", (t) => {
    const f = fixture(
      t,
      `${CONFIG}[secrets.keys.KIT_TEST_ABSENT_KEY]\nsource = "env"\n`, // not in the fixture env
    );
    const marker = join(f.cwd, "child-ran");
    const result = f.run([
      "run",
      "--inject",
      "--",
      process.execPath,
      "-e",
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`,
    ]);
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(marker), false, "an unresolved secret must prevent the child");
    assert.match(result.stderr, /KIT_TEST_ABSENT_KEY/);
    assert.ok(!result.stderr.includes(VALUE));
  });

  it("without --inject keeps today's behaviour: .env.local is read, no secret is resolved", (t) => {
    const f = fixture(t);
    writeFileSync(join(f.cwd, ".env.local"), "ONLY_IN_FILE=x\n");
    const result = f.run(["run", "--", process.execPath, "-e", PROBE]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /len=missing/);
    assert.match(result.stdout, /file=x/);
  });
});

describe("kit secrets and .env.local in 7.x", () => {
  it("still writes .env.local and prints one deprecation line on stderr", (t) => {
    const f = fixture(t);
    const result = f.run(["secrets"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(join(f.cwd, ".env.local"), "utf-8"), /^DEMO_INJECT=/m);
    const lines = result.stderr.split("\n").filter((line) => NOTICE.test(line));
    assert.equal(lines.length, 1, result.stderr);
    assert.doesNotMatch(result.stdout, NOTICE);
  });

  it("--write-env-file writes the same file and prints no notice", (t) => {
    const f = fixture(t);
    const result = f.run(["secrets", "--write-env-file"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(join(f.cwd, ".env.local"), "utf-8"), /^DEMO_INJECT=/m);
    assert.doesNotMatch(result.stderr, NOTICE);
  });
});
