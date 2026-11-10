import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { readAuditLog } from "./audit.js";
import {
  checkGovernance,
  runGoverned,
  runGovernedBrokered,
  withGovernance,
} from "./governance-middleware.js";
import {
  budgetContents,
  governanceConfig,
  governanceFixture,
  seedBudget,
} from "./governance-outcome.test-support.js";

for (const run of [withGovernance, runGoverned, runGovernedBrokered]) {
  it(`${run.name} uses target budget limits and counters`, async (t) => {
    const { host, target } = governanceFixture(t);
    const hostBefore = seedBudget(host, 100, 2);
    seedBudget(target, 90, 0);
    const opts = { cwd: target };
    let calls = 0;
    const operation = async () => ++calls;
    const context = { operation: "repair", operationType: "write" as const, estimatedTokens: 5 };
    await run(governanceConfig, context, operation, opts);
    assert.equal(calls, 1);
    assert.equal(JSON.parse(budgetContents(target)!).tokens_today, 95);
    const tokenDenial = await run(
      governanceConfig,
      { ...context, estimatedTokens: 6 },
      operation,
      opts,
    ).catch((error: Error) => ({ ok: false, reason: error.message }));
    assert.equal(typeof tokenDenial === "object" && tokenDenial.ok, false);
    assert.equal(calls, 1);
    await run(governanceConfig, context, operation, opts);
    assert.equal(calls, 2);
    const operationDenial = await run(
      governanceConfig,
      { ...context, estimatedTokens: 0 },
      operation,
      opts,
    ).catch((error: Error) => ({ ok: false, reason: error.message }));
    assert.equal(typeof operationDenial === "object" && operationDenial.ok, false);
    assert.equal(calls, 2);
    assert.equal(budgetContents(host), hostBefore);
  });

  it(`${run.name} keeps the same project after the callback changes process.cwd`, async (t) => {
    const { host, target, root } = governanceFixture(t);
    const other = join(root, "other", "nested");
    mkdirSync(other, { recursive: true });
    const hostBefore = seedBudget(host, 0, 0);
    await run(
      governanceConfig,
      { operation: "repair", operationType: "write", estimatedTokens: 4 },
      async () => {
        process.chdir(other);
        return "repaired";
      },
      { cwd: "../target" },
    );
    assert.equal(budgetContents(host), hostBefore);
    assert.equal(JSON.parse(budgetContents(target) ?? "null")?.tokens_today, 4);
    assert.equal((await readAuditLog(join(target, ".kit-audit.jsonl"))).length, 1);
    assert.equal(budgetContents(join(root, "other", "target")), undefined);
  });
}

it("checkGovernance reads target limits without consuming budget", async (t) => {
  const { host, target } = governanceFixture(t);
  const hostBefore = seedBudget(host, 0, 0);
  const targetBefore = seedBudget(target, 0, 2);
  const result = await checkGovernance(
    governanceConfig,
    { operation: "repair", operationType: "write" },
    { cwd: target },
  );
  assert.equal(result.allowed, false);
  assert.match(result.reason!, /Operation budget exceeded/);
  assert.equal(budgetContents(host), hostBefore);
  assert.equal(budgetContents(target), targetBefore);
});
