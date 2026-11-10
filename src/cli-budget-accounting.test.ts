import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { readAuditLog } from "./audit.js";
import { createCliContractFixture } from "./cli-contract.test-support.js";
import { projectConfig, seedBudget } from "./governance-outcome.test-support.js";

it("refuses the child before execution when budget storage fails", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    t.skip("Expected: this permission fixture requires POSIX and a non-root user.");
    return;
  }
  const fixture = createCliContractFixture(projectConfig);
  t.after(() => fixture.cleanup());
  const before = seedBudget(fixture.cwd, 0, 0);
  const path = join(fixture.cwd, ".kit-budget.json");
  chmodSync(path, 0o400);
  const result = fixture.run([
    "run",
    "--",
    process.execPath,
    "-e",
    `require('node:fs').writeFileSync('child-ran', 'yes'); process.exitCode=7`,
  ]);
  chmodSync(path, 0o600);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /Could not save budget usage/);
  assert.equal(existsSync(join(fixture.cwd, "child-ran")), false);
  assert.equal(readFileSync(path, "utf8"), before);
  const events = await readAuditLog(join(fixture.cwd, ".kit-audit.jsonl"));
  assert.equal(events.length, 1);
  assert.equal(events[0].operation, "run");
  assert.equal(events[0].success, false);
  assert.equal(events[0].error, "Could not save budget usage. Check .kit-budget.json.");
  assert.equal(events[0].metadata?.phase, undefined);
  assert.equal(events[0].metadata?.operation_success, undefined);
});

it("retains child outcome when the booked ledger becomes unwritable during execution", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    t.skip("Expected: this permission fixture requires POSIX and a non-root user.");
    return;
  }
  const fixture = createCliContractFixture(projectConfig);
  t.after(() => fixture.cleanup());
  seedBudget(fixture.cwd, 0, 0);
  const path = join(fixture.cwd, ".kit-budget.json");
  let result;
  try {
    result = fixture.run([
      "run",
      "--",
      process.execPath,
      "-e",
      `
const fs = require('node:fs');
fs.writeFileSync('child-ran', 'yes');
fs.chmodSync('.kit-budget.json', 0o400);
process.exitCode = 7;
`,
    ]);
  } finally {
    chmodSync(path, 0o600);
  }
  assert.equal(result.status, 7, result.stdout + result.stderr);
  assert.equal(readFileSync(join(fixture.cwd, "child-ran"), "utf8"), "yes");
  assert.equal(JSON.parse(readFileSync(path, "utf8")).operations_this_hour, 1);
  const events = await readAuditLog(join(fixture.cwd, ".kit-audit.jsonl"));
  assert.equal(events.length, 1);
  assert.equal(events[0].success, false);
  assert.equal(events[0].error, "Command exited with code 7");
  assert.equal(events[0].metadata?.phase, undefined);
});
