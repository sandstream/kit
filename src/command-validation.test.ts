import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { createCliContractFixture } from "./cli-contract.test-support.js";

let fixture: ReturnType<typeof createCliContractFixture>;
let cwd: string;
beforeEach(() => {
  fixture = createCliContractFixture(
    'version = 1\n[secrets]\nstore = "env"\n[secrets.keys.KIT_SYNTHETIC_VALUE]\nsource = "env"\n',
  );
  cwd = fixture.cwd;
});
afterEach(() => fixture.cleanup());
const run = (args: string[]) => fixture.run(args);
const snapshot = () => fixture.snapshot();

for (const existing of [false, true]) {
  it(`refuses unsupported secrets preview without ${existing ? "overwriting" : "creating"} files`, () => {
    if (existing) writeFileSync(join(cwd, ".env.local"), "KEEP_SYNTHETIC_VALUE=unchanged\n");
    const before = snapshot();
    const result = run(["secrets", "--dry-run"]);
    assert.deepEqual(snapshot(), before, "a refused preview must preserve project and home state");
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /--dry-run is not supported/);
  });
}

it("refuses unsupported guard preview before installing shims or editing shell files", () => {
  const before = snapshot();
  const result = run(["guard", "install", "--dry-run"]);
  assert.deepEqual(snapshot(), before);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /--dry-run is not supported/);
});

for (const value of ["true", "1", "false", "0", ""]) {
  it(`refuses --dry-run=${value} before a config migration can write`, () => {
    writeFileSync(join(cwd, ".kit.toml"), "version = 0\n");
    const before = snapshot();
    const result = run(["config", "migrate", `--dry-run=${value}`]);
    assert.deepEqual(snapshot(), before);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /--dry-run does not accept a value/);
  });
}

it("keeps the supported config preview functional without changing files", () => {
  writeFileSync(join(cwd, ".kit.toml"), "version = 0\n");
  const before = snapshot();
  const result = run(["config", "migrate", "--dry-run"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Planned migration/);
  assert.deepEqual(snapshot(), before);
});

it("keeps the supported secrets sync preview functional without writing values", () => {
  const before = snapshot();
  const result = run(["secrets", "sync", "--target=dotenv-ci", "--dry-run"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Would sync/);
  assert.ok(!result.stdout.includes("public-fixture-value"));
  assert.deepEqual(snapshot(), before);
});

it("passes a child command's dry-run argument through kit run", () => {
  const result = run([
    "run",
    "--",
    process.execPath,
    "-e",
    "console.log(JSON.stringify(process.argv.slice(1)))",
    "--",
    "--dry-run",
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\["--dry-run"\]/);
});

it("keeps version requests ahead of preview validation and command dispatch", () => {
  const before = snapshot();
  const result = run(["secrets", "--dry-run", "--version"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\n$/);
  assert.deepEqual(snapshot(), before);
});

it("leaves forwarded preview arguments to the guard observation protocol", () => {
  const result = run(["guard-observe", "node", "--dry-run"]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.stderr.includes("--dry-run is not supported"));
});

it("leaves forwarded environment arguments to the guard observation protocol", () => {
  const result = run(["guard-observe", "node", "--env"]);
  assert.equal(result.status, 0, result.stderr);
});

it("refuses an unsupported preview before read-only initialization writes an audit event", () => {
  const before = snapshot();
  const result = run(["--read-only", "secrets", "--dry-run"]);
  assert.equal(result.status, 2, result.stderr);
  assert.deepEqual(snapshot(), before);
});
