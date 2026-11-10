import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { checkBudgetLimits, clearBudgetState, getBudgetStatus, recordUsage } from "./budget.js";

const config = { enabled: true };
const stateError = "Could not read budget usage. Check .kit-budget.json.";

async function fixture(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "kit-budget-state-validation-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const path = join(cwd, ".kit-budget.json");
  return { cwd, path };
}

function validState() {
  const now = new Date().toISOString();
  return {
    tokens_today: 42,
    operations_this_hour: 3,
    last_token_reset: now,
    last_operation_reset: now,
  };
}

it("budget APIs refuse invalid stored usage without changes or source text in errors", async (t) => {
  const { cwd, path } = await fixture(t);
  const invalid: unknown[] = [null, [], 42, "fixture-secret-marker", {}, { tokens_today: 0 }];
  for (const field of ["tokens_today", "operations_this_hour"] as const) {
    for (const value of [null, "fixture-secret-marker", -1, [], {}, false]) {
      invalid.push({ ...validState(), [field]: value });
    }
  }
  invalid.push({ ...validState(), generation: "fixture-secret-marker" });
  invalid.push({ ...validState(), generation: 7 });
  invalid.push({ ...validState(), operations_this_hour: 0.5 });
  invalid.push({ ...validState(), operations_this_hour: Number.MAX_SAFE_INTEGER + 1 });
  for (const field of ["last_token_reset", "last_operation_reset"] as const) {
    for (const value of [
      null,
      0,
      "",
      "fixture-secret-marker",
      "2026-02-30T00:00:00.000Z",
      "9999-01-01T00:00:00.000Z",
    ]) {
      invalid.push({ ...validState(), [field]: value });
    }
  }
  const contents = invalid.map((value) => JSON.stringify(value));
  contents.push(JSON.stringify(validState()).replace('"tokens_today":42', '"tokens_today":1e999'));
  for (const [index, content] of contents.entries()) {
    await t.test(`invalid state ${index + 1}`, async () => {
      await writeFile(path, content);
      await assert.rejects(getBudgetStatus(config, { cwd }), { message: stateError });
      assert.deepEqual(await checkBudgetLimits(config, 1, { cwd }), {
        allowed: false,
        reason: stateError,
      });
      await assert.rejects(recordUsage(config, 1, { cwd }), { message: stateError });
      assert.equal(await readFile(path, "utf8"), content);
    });
  }
});

it("missing state stays unwritten until usage is recorded and corrupt state can be cleared", async (t) => {
  const { cwd, path } = await fixture(t);
  assert.deepEqual(await getBudgetStatus(config, { cwd }), {
    tokens_used: 0,
    tokens_limit: 1_000_000,
    operations_used: 0,
    operations_limit: 100,
  });
  assert.deepEqual(await checkBudgetLimits(config, 1, { cwd }), { allowed: true });
  await assert.rejects(readFile(path), { code: "ENOENT" });
  await writeFile(path, "{invalid fixture-secret-marker");
  await clearBudgetState({ cwd });
  await clearBudgetState({ cwd });
  await recordUsage(config, 2, { cwd });
  assert.equal((await getBudgetStatus(config, { cwd })).tokens_used, 2);
  assert.equal((await getBudgetStatus(config, { cwd })).operations_used, 1);
});

it("public token inputs cannot reduce usage or bypass a budget with nonfinite values", async (t) => {
  const { cwd, path } = await fixture(t);
  await recordUsage(config, 42, { cwd });
  const before = await readFile(path, "utf8");
  for (const value of [-1, NaN, Infinity, -Infinity]) {
    assert.equal((await checkBudgetLimits(config, value, { cwd })).allowed, false);
    await assert.rejects(recordUsage(config, value, { cwd }), /Invalid budget token usage/);
    assert.equal(await readFile(path, "utf8"), before);
  }
  await recordUsage(config, 0.5, { cwd });
  assert.equal((await getBudgetStatus(config, { cwd })).tokens_used, 42.5);
});
