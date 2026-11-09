import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { clearBudgetState, getBudgetStatus, recordUsage, withBudget } from "./budget.js";

async function fixture(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "kit-budget-reservation-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return { cwd };
}

it("concurrent usage records retain every charge", async (t) => {
  const opts = await fixture(t);
  const config = { enabled: true };
  await Promise.all(Array.from({ length: 20 }, () => recordUsage(config, 2, opts)));
  const status = await getBudgetStatus(config, opts);
  assert.equal(status.operations_used, 20);
  assert.equal(status.tokens_used, 40);
});

it("a returned failure remains charged and a thrown operation refunds exactly once", async (t) => {
  const opts = await fixture(t);
  const config = { enabled: true, agent: { max_operations_per_hour: 2 } };
  const value = { ok: false };
  assert.equal(await withBudget(config, 3, async () => value, opts), value);
  const original = new Error("fixture operation failed");
  await assert.rejects(
    withBudget(
      config,
      5,
      async () => {
        throw original;
      },
      opts,
    ),
    (error) => error === original,
  );
  assert.equal((await getBudgetStatus(config, opts)).operations_used, 1);
  assert.equal((await getBudgetStatus(config, opts)).tokens_used, 3);
  assert.equal(await withBudget(config, 7, async () => "next operation", opts), "next operation");
  const status = await getBudgetStatus(config, opts);
  assert.equal(status.operations_used, 2);
  assert.equal(status.tokens_used, 10);
});

it("a thrown operation cannot refund a replacement ledger", async (t) => {
  const opts = await fixture(t);
  const config = { enabled: true };
  await assert.rejects(
    withBudget(
      config,
      6,
      async () => {
        await clearBudgetState(opts);
        await withBudget(config, 4, async () => "new ledger", opts);
        throw new Error("old operation failed");
      },
      opts,
    ),
    /old operation failed/,
  );
  const status = await getBudgetStatus(config, opts);
  assert.equal(status.operations_used, 1);
  assert.equal(status.tokens_used, 4);
});

for (const [outerTokens, innerTokens] of [
  [0.1, 0.7],
  [0.2, 0.1],
]) {
  it(`refunds fractional estimates ${outerTokens} and ${innerTokens} without replacing errors`, async (t) => {
    const opts = await fixture(t);
    const config = { enabled: true, agent: { max_operations_per_hour: 2 } };
    const outerError = new Error("outer operation failed");
    const innerError = new Error("inner operation failed");
    await assert.rejects(
      withBudget(
        config,
        outerTokens,
        async () => {
          await assert.rejects(
            withBudget(
              config,
              innerTokens,
              async () => {
                throw innerError;
              },
              opts,
            ),
            (error) => error === innerError,
          );
          throw outerError;
        },
        opts,
      ),
      (error) => error === outerError,
    );
    const status = await getBudgetStatus(config, opts);
    assert.equal(status.tokens_used, 0);
    assert.equal(status.operations_used, 0);
  });
}

for (const retainedTokens of [1, 0.5]) {
  it(`retains ${retainedTokens} tokens when a large estimate is refunded`, async (t) => {
    const opts = await fixture(t);
    const estimate = 2 ** 51;
    const config = { enabled: true, agent: { max_tokens_per_day: estimate + 10 } };
    const original = new Error("large operation failed");
    await assert.rejects(
      withBudget(
        config,
        estimate,
        async () => {
          await withBudget(config, retainedTokens, async () => ({ ok: false }), opts);
          throw original;
        },
        opts,
      ),
      (error) => error === original,
    );
    const status = await getBudgetStatus(config, opts);
    assert.equal(status.tokens_used, retainedTokens);
    assert.equal(status.operations_used, 1);
  });
}

for (const elapsed of [2 * 60 * 60 * 1000, 2 * 24 * 60 * 60 * 1000]) {
  it(`a refund preserves usage recorded after ${elapsed} milliseconds`, async (t) => {
    const opts = await fixture(t);
    const config = { enabled: true };
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    await assert.rejects(
      withBudget(
        config,
        6,
        async () => {
          t.mock.timers.tick(elapsed);
          await recordUsage(config, 4, opts);
          throw new Error("earlier operation failed");
        },
        opts,
      ),
      /earlier operation failed/,
    );
    const status = await getBudgetStatus(config, opts);
    assert.equal(status.tokens_used, 4);
    assert.equal(status.operations_used, 1);
  });
}
