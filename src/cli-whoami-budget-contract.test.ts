import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { readAuditLog } from "./audit.js";
import { clearBudgetState } from "./budget.js";
import { createCliContractFixture } from "./cli-contract.test-support.js";
import { projectConfig } from "./governance-outcome.test-support.js";

it("whoami refuses an unreadable budget instead of reporting unused allowance", (t) => {
  const fixture = createCliContractFixture(projectConfig);
  t.after(() => fixture.cleanup());
  writeFileSync(join(fixture.cwd, ".kit-budget.json"), "{broken budget");
  const before = fixture.snapshot();
  const result = fixture.run(["whoami", "--json"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const data = JSON.parse(result.stdout);
  assert.equal(data.ok, false);
  assert.match(data.error, /budget/i);
  assert.equal(data.budget, undefined);
  assert.deepEqual(fixture.snapshot(), before);
});

it("an unreadable budget denies child execution and records the denial", async (t) => {
  const fixture = createCliContractFixture(projectConfig);
  t.after(() => fixture.cleanup());
  const path = join(fixture.cwd, ".kit-budget.json");
  writeFileSync(path, "{broken budget");
  const result = fixture.run([
    "run",
    "--",
    process.execPath,
    "-e",
    "require('node:fs').writeFileSync('child-ran', 'unexpected')",
  ]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /budget/i);
  assert.equal(existsSync(join(fixture.cwd, "child-ran")), false);
  assert.equal(readFileSync(path, "utf8"), "{broken budget");
  const events = await readAuditLog(join(fixture.cwd, ".kit-audit.jsonl"));
  assert.equal(events.length, 1);
  assert.equal(events[0].operation, "run");
  assert.equal(events[0].success, false);
  assert.match(events[0].error ?? "", /budget/i);
});

it("invalid stored usage gives sanitized CLI errors and an audited refusal", async (t) => {
  const now = new Date().toISOString();
  const valid = {
    tokens_today: 0,
    operations_this_hour: 0,
    last_token_reset: now,
    last_operation_reset: now,
  };
  const cases = [
    "null",
    JSON.stringify({ note: "fixture-secret-marker" }),
    JSON.stringify({ ...valid, tokens_today: -1 }),
    JSON.stringify({ ...valid, operations_this_hour: 0.5 }),
    JSON.stringify({ ...valid, last_token_reset: "fixture-secret-marker" }),
  ];
  for (const [index, content] of cases.entries()) {
    await t.test(`invalid CLI state ${index + 1}`, async () => {
      const fixture = createCliContractFixture(projectConfig);
      t.after(() => fixture.cleanup());
      const path = join(fixture.cwd, ".kit-budget.json");
      writeFileSync(path, content);
      const before = fixture.snapshot();
      const report = fixture.run(["whoami", "--json"]);
      assert.equal(report.status, 1, report.stdout + report.stderr);
      assert.deepEqual(JSON.parse(report.stdout), {
        ok: false,
        error: "Could not read budget usage. Check .kit-budget.json.",
      });
      assert.doesNotMatch(report.stdout + report.stderr, /fixture-secret-marker/);
      assert.deepEqual(fixture.snapshot(), before);
      const run = fixture.run([
        "run",
        "--",
        process.execPath,
        "-e",
        "require('node:fs').writeFileSync('child-ran', 'unexpected')",
      ]);
      assert.equal(run.status, 1, run.stdout + run.stderr);
      assert.doesNotMatch(run.stdout + run.stderr, /fixture-secret-marker/);
      assert.equal(existsSync(join(fixture.cwd, "child-ran")), false);
      assert.equal(readFileSync(path, "utf8"), content);
      const events = await readAuditLog(join(fixture.cwd, ".kit-audit.jsonl"));
      assert.equal(events.length, 1);
      assert.equal(events[0].success, false);
      assert.equal(events[0].error, "Could not read budget usage. Check .kit-budget.json.");
    });
  }
});

for (const broken of [false, true]) {
  it(`CLI refuses a ${broken ? "broken" : "valid"} budget symlink without changing its target`, async (t) => {
    const fixture = createCliContractFixture(projectConfig);
    t.after(() => fixture.cleanup());
    const path = join(fixture.cwd, ".kit-budget.json");
    const outside = join(fixture.root, "outside-state");
    const content = JSON.stringify({
      tokens_today: 0,
      operations_this_hour: 0,
      last_token_reset: new Date().toISOString(),
      last_operation_reset: new Date().toISOString(),
    });
    if (!broken) writeFileSync(outside, content);
    symlinkSync(outside, path);
    const namesBefore = readdirSync(fixture.root, { recursive: true });
    const report = fixture.run(["whoami", "--json"]);
    assert.equal(report.status, 1, report.stdout + report.stderr);
    assert.equal(JSON.parse(report.stdout).ok, false);
    assert.deepEqual(readdirSync(fixture.root, { recursive: true }), namesBefore);
    const run = fixture.run([
      "run",
      "--",
      process.execPath,
      "-e",
      "require('node:fs').writeFileSync('child-ran', 'unexpected')",
    ]);
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.equal(existsSync(join(fixture.cwd, "child-ran")), false);
    assert.equal(lstatSync(path).isSymbolicLink(), true);
    assert.equal(readlinkSync(path), outside);
    if (!broken) assert.equal(readFileSync(outside, "utf8"), content);
    else assert.equal(existsSync(outside), false);
    const events = await readAuditLog(join(fixture.cwd, ".kit-audit.jsonl"));
    assert.equal(events.length, 1);
    assert.equal(events[0].success, false);
    assert.match(events[0].error ?? "", /budget/i);
  });
}

it("CLI keeps missing state unwritten for reports and permits a run after explicit recovery", async (t) => {
  const fixture = createCliContractFixture(projectConfig);
  t.after(() => fixture.cleanup());
  const path = join(fixture.cwd, ".kit-budget.json");
  const before = fixture.snapshot();
  const report = fixture.run(["whoami", "--json"]);
  assert.equal(report.status, 0, report.stdout + report.stderr);
  assert.deepEqual(JSON.parse(report.stdout).budget, {
    tokens_used: 0,
    tokens_limit: 100,
    operations_used: 0,
    operations_limit: 2,
  });
  assert.deepEqual(fixture.snapshot(), before);
  writeFileSync(path, "{broken budget");
  await clearBudgetState({ cwd: fixture.cwd });
  const run = fixture.run([
    "run",
    "--",
    process.execPath,
    "-e",
    "require('node:fs').writeFileSync('child-ran', 'expected')",
  ]);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.equal(readFileSync(join(fixture.cwd, "child-ran"), "utf8"), "expected");
  assert.equal(JSON.parse(readFileSync(path, "utf8")).operations_this_hour, 1);
});

it("CLI reports an explicit zero operation limit and refuses execution", async (t) => {
  const fixture = createCliContractFixture(
    projectConfig.replace("max_operations_per_hour = 2", "max_operations_per_hour = 0"),
  );
  t.after(() => fixture.cleanup());
  const report = fixture.run(["whoami", "--json"]);
  assert.equal(report.status, 0, report.stdout + report.stderr);
  assert.equal(JSON.parse(report.stdout).budget.operations_limit, 0);
  const run = fixture.run([
    "run",
    "--",
    process.execPath,
    "-e",
    "require('node:fs').writeFileSync('child-ran', 'unexpected')",
  ]);
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.equal(existsSync(join(fixture.cwd, "child-ran")), false);
  const events = await readAuditLog(join(fixture.cwd, ".kit-audit.jsonl"));
  assert.equal(events.length, 1);
  assert.equal(events[0].success, false);
  assert.match(events[0].error ?? "", /Operation budget exceeded: 0\/0/);
});
