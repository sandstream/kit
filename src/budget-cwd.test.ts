import assert from "node:assert/strict";
import { it } from "node:test";
import { checkBudgetLimits, clearBudgetState, getBudgetStatus, recordUsage } from "./budget.js";
import {
  budgetContents,
  governanceConfig,
  governanceFixture,
  seedBudget,
} from "./governance-outcome.test-support.js";

it("budget usage reads and updates the requested project without changing the host", async (t) => {
  const { host, target } = governanceFixture(t);
  const hostBefore = seedBudget(host, 90, 1);
  seedBudget(target, 20, 0);
  await recordUsage(governanceConfig.governance, 5, { cwd: target });
  assert.equal(budgetContents(host), hostBefore);
  const targetBudget = JSON.parse(budgetContents(target)!);
  assert.equal(targetBudget.tokens_today, 25);
  assert.equal(targetBudget.operations_this_hour, 1);
});

it("budget limits, status, and reset use the requested project", async (t) => {
  const { host, target } = governanceFixture(t);
  const hostBefore = seedBudget(host, 0, 0);
  seedBudget(target, 95, 1);
  const opts = { cwd: "../target" };
  assert.equal((await checkBudgetLimits(governanceConfig.governance, 6, opts)).allowed, false);
  assert.equal((await checkBudgetLimits(governanceConfig.governance, 5, opts)).allowed, true);
  assert.equal((await getBudgetStatus(governanceConfig.governance, opts)).tokens_used, 95);
  seedBudget(target, 0, 2);
  assert.equal((await checkBudgetLimits(governanceConfig.governance, 0, opts)).allowed, false);
  await clearBudgetState(opts);
  assert.equal(budgetContents(target), undefined);
  assert.equal((await getBudgetStatus(governanceConfig.governance, opts)).operations_used, 0);
  assert.equal(budgetContents(host), hostBefore);
});
