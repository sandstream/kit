import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { readAuditLog } from "./audit.js";
import { getBudgetStatus } from "./budget.js";
import { runGoverned, runGovernedBrokered, withGovernance } from "./governance-middleware.js";
import {
  budgetContents,
  governanceConfig,
  governanceFixture,
} from "./governance-outcome.test-support.js";

it("withGovernance audits a returned failure and preserves the original result", async (t) => {
  const { target } = governanceFixture(t);
  const result = { ok: false, error: "Template parent is missing", actions: ["lock created"] };
  const returned = await withGovernance(
    governanceConfig,
    { operation: "repair", operationType: "write", estimatedTokens: 3 },
    async () => result,
    { cwd: target, assessResult: (value) => ({ success: value.ok, error: value.error }) },
  );
  assert.equal(returned, result);
  const events = await readAuditLog(join(target, ".kit-audit.jsonl"));
  assert.equal(events.length, 1);
  assert.equal(events[0].success, false);
  assert.equal(events[0].error, result.error);
  assert.equal(JSON.parse(budgetContents(target)!).operations_this_hour, 1);
});

for (const run of [withGovernance, runGoverned, runGovernedBrokered]) {
  it(`${run.name} preserves generic return values without an assessor`, async (t) => {
    const { target } = governanceFixture(t);
    const config = {
      governance: { ...governanceConfig.governance, agent: { max_operations_per_hour: 100 } },
    };
    const values = [
      undefined,
      null,
      false,
      0,
      { ok: false },
      { success: false },
      [{ action: "failed" }],
    ];
    for (const value of values) {
      const returned = await run(
        config,
        { operation: "generic", operationType: "write" },
        async () => value,
        { cwd: target },
      );
      if (run === withGovernance) assert.equal(returned, value);
      else assert.deepEqual(returned, { ok: true, result: value });
    }
    const events = await readAuditLog(join(target, ".kit-audit.jsonl"));
    assert.equal(events.length, values.length);
    assert.ok(events.every((event) => event.success === true && event.error === undefined));
    assert.ok(events.every((event) => event.metadata?.phase !== "accounting-failed"));
  });

  it(`${run.name} audits thrown errors without charging usage`, async (t) => {
    const { target } = governanceFixture(t);
    const failure = new Error("repair threw");
    const execute = () =>
      run(
        governanceConfig,
        { operation: "repair", operationType: "write" },
        async () => {
          throw failure;
        },
        { cwd: target },
      );
    if (run === withGovernance) await assert.rejects(execute, (error) => error === failure);
    else assert.deepEqual(await execute(), { ok: false, reason: failure.message });
    const usage = await getBudgetStatus(governanceConfig.governance, { cwd: target });
    assert.equal(usage.operations_used, 0);
    assert.equal(usage.tokens_used, 0);
    const events = await readAuditLog(join(target, ".kit-audit.jsonl"));
    assert.equal(events.length, 1);
    assert.equal(events[0].success, false);
    assert.equal(events[0].error, failure.message);
  });
}

it("runGovernedBrokered retains an assessed undefined result and audits both layers", async (t) => {
  const { target } = governanceFixture(t);
  writeFileSync(
    join(target, ".kit-exec-broker.json"),
    JSON.stringify({
      egress: { allow: [] },
      fs: { root: target },
      env: { declared: [] },
    }),
  );
  const returned = await runGovernedBrokered(
    governanceConfig,
    { operation: "repair", operationType: "write", declaredEffects: true },
    async () => undefined,
    { cwd: target, assessResult: () => ({ success: false }) },
  );
  assert.deepEqual(returned, {
    ok: false,
    result: undefined,
    reason: "Operation reported failure",
  });
  const events = (await readAuditLog(join(target, ".kit-audit.jsonl"))).filter(
    (event) => event.metadata?.phase !== "authorized",
  );
  assert.equal(events.length, 2);
  assert.ok(events.every((event) => event.success === false && event.error === returned.reason));
});

it("disabled governance preserves assessed failures without audit or budget writes", async (t) => {
  const { target } = governanceFixture(t);
  const value = { ok: false, error: "repair failed" };
  const opts = {
    cwd: target,
    assessResult: (result: typeof value) => ({ success: result.ok, error: result.error }),
  };
  for (const run of [runGoverned, runGovernedBrokered]) {
    assert.deepEqual(
      await run(
        { governance: { enabled: false } },
        { operation: "repair", operationType: "write" },
        async () => value,
        opts,
      ),
      { ok: false, result: value, reason: value.error },
    );
  }
  assert.equal(
    await withGovernance(
      { governance: { enabled: false } },
      { operation: "repair", operationType: "write" },
      async () => value,
      opts,
    ),
    value,
  );
  assert.equal(budgetContents(target), undefined);
  assert.deepEqual(await readAuditLog(join(target, ".kit-audit.jsonl")), []);
});

it("runGoverned reports and audits an assessed failure without losing its result", async (t) => {
  const { target } = governanceFixture(t);
  const result = { status: "failed", detail: "Template parent is missing" };
  const returned = await runGoverned(
    governanceConfig,
    { operation: "repair", operationType: "write" },
    async () => result,
    {
      cwd: target,
      assessResult: (value) => ({ success: value.status !== "failed", error: value.detail }),
    },
  );
  assert.deepEqual(returned, { ok: false, result, reason: result.detail });
  const events = await readAuditLog(join(target, ".kit-audit.jsonl"));
  assert.equal(events.length, 1);
  assert.equal(events[0].success, false);
  assert.equal(events[0].error, result.detail);
});
