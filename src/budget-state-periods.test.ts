import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { checkBudgetLimits, getBudgetStatus, recordUsage } from "./budget.js";

const config = {
  enabled: true,
  agent: { max_tokens_per_day: 100, max_operations_per_hour: 2 },
};

async function fixture(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "kit-budget-state-periods-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return { cwd, path: join(cwd, ".kit-budget.json") };
}

it("daily usage expires on the same day number in a different month or year", async (t) => {
  const now = new Date(2026, 10, 5, 12);
  t.mock.timers.enable({ apis: ["Date"], now });
  const { cwd, path } = await fixture(t);
  for (const lastReset of [new Date(2026, 9, 5, 12), new Date(2025, 10, 5, 12)]) {
    const content = JSON.stringify({
      tokens_today: 95,
      operations_this_hour: 1,
      last_token_reset: lastReset.toISOString(),
      last_operation_reset: now.toISOString(),
    });
    await writeFile(path, content);
    const status = await getBudgetStatus(config, { cwd });
    assert.equal(status.tokens_used, 0);
    assert.equal(status.operations_used, 1);
    assert.deepEqual(await checkBudgetLimits(config, 10, { cwd }), { allowed: true });
    assert.equal(await readFile(path, "utf8"), content);
    await recordUsage(config, 10, { cwd });
    assert.equal((await getBudgetStatus(config, { cwd })).tokens_used, 10);
  }
});

it("daily usage resets at local midnight while hourly usage lasts one elapsed hour", async (t) => {
  const now = new Date(2027, 0, 1, 0, 5);
  t.mock.timers.enable({ apis: ["Date"], now });
  const { cwd, path } = await fixture(t);
  await writeFile(
    path,
    JSON.stringify({
      tokens_today: 100,
      operations_this_hour: 2,
      last_token_reset: new Date(2026, 11, 31, 23, 30).toISOString(),
      last_operation_reset: new Date(now.getTime() - 3_599_999).toISOString(),
    }),
  );
  assert.equal((await getBudgetStatus(config, { cwd })).tokens_used, 0);
  assert.equal((await getBudgetStatus(config, { cwd })).operations_used, 2);
  assert.equal((await checkBudgetLimits(config, 1, { cwd })).allowed, false);
  t.mock.timers.tick(1);
  assert.equal((await getBudgetStatus(config, { cwd })).operations_used, 0);
  assert.equal((await checkBudgetLimits(config, 1, { cwd })).allowed, true);
  await recordUsage(config, 5, { cwd });
  assert.deepEqual(await getBudgetStatus(config, { cwd }), {
    tokens_used: 5,
    tokens_limit: 100,
    operations_used: 1,
    operations_limit: 2,
  });
});
