import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { checkBudgetLimits, getBudgetStatus, recordUsage, withBudget } from "./budget.js";
import type { GovernanceAgentConfig } from "./config.js";

const invalid: GovernanceAgentConfig[] = [];
for (const value of [-1, NaN, Infinity, -Infinity]) {
  invalid.push({ max_tokens_per_day: value }, { max_operations_per_hour: value });
}
invalid.push(
  { max_operations_per_hour: 1.5 },
  { max_operations_per_hour: Number.MAX_SAFE_INTEGER + 1 },
);

for (const [index, agent] of invalid.entries()) {
  it(`budget API refuses invalid limit ${index + 1} without effects`, async (t) => {
    const cwd = await mkdtemp(join(tmpdir(), "kit-budget-limits-"));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const config = { enabled: true, agent };
    let calls = 0;
    await t.test("admission", async () => {
      await assert.rejects(
        withBudget(config, 0, async () => ++calls, { cwd }),
        /Invalid budget limit/,
      );
      assert.equal(calls, 0);
    });
    await t.test("advisory check", async () => {
      const result = await checkBudgetLimits(config, 0, { cwd });
      assert.equal(result.allowed, false);
      assert.match(result.reason ?? "", /Invalid budget limit/);
    });
    await t.test("inspection", async () => {
      await assert.rejects(getBudgetStatus(config, { cwd }), /Invalid budget limit/);
    });
    await t.test("usage record", async () => {
      await assert.rejects(recordUsage(config, 0, { cwd }), /Invalid budget limit/);
    });
    assert.deepEqual(await readdir(cwd), []);
  });
}

it("undefined optional limits retain the effective defaults", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "kit-budget-defaults-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const config = {
    enabled: true,
    agent: { max_tokens_per_day: undefined, max_operations_per_hour: undefined },
  };
  assert.deepEqual(await getBudgetStatus(config, { cwd }), {
    tokens_used: 0,
    tokens_limit: 1_000_000,
    operations_used: 0,
    operations_limit: 100,
  });
  let calls = 0;
  await assert.rejects(
    withBudget(config, 1_000_001, async () => ++calls, { cwd }),
    /Token budget exceeded/,
  );
  assert.equal(calls, 0);
});
