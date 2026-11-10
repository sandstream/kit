import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { checkBudgetLimits, formatBudgetStatus, getBudgetStatus } from "./budget.js";

it("zero token and operation limits remain explicit limits", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "kit-budget-state-limits-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const tokens = { enabled: true, agent: { max_tokens_per_day: 0 } };
  assert.equal((await checkBudgetLimits(tokens, 1, { cwd })).allowed, false);
  assert.equal((await checkBudgetLimits(tokens, 0, { cwd })).allowed, true);
  const operations = { enabled: true, agent: { max_operations_per_hour: 0 } };
  assert.equal((await checkBudgetLimits(operations, 0, { cwd })).allowed, false);
  assert.equal((await getBudgetStatus(tokens, { cwd })).tokens_limit, 0);
  assert.equal((await getBudgetStatus(operations, { cwd })).operations_limit, 0);
  const display = formatBudgetStatus({
    tokens_used: 0,
    tokens_limit: 0,
    operations_used: 0,
    operations_limit: 0,
  });
  assert.match(display, /Tokens: 0\/0/);
  assert.match(display, /Operations: 0\/0/);
  assert.doesNotMatch(display, /no limit|NaN|Infinity/);
});

it("enabled governance applies default limits when no limits are specified", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "kit-budget-state-defaults-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  assert.equal((await checkBudgetLimits({ enabled: true }, 1_000_001, { cwd })).allowed, false);
  assert.deepEqual(await getBudgetStatus({ enabled: true }, { cwd }), {
    tokens_used: 0,
    tokens_limit: 1_000_000,
    operations_used: 0,
    operations_limit: 100,
  });
});
