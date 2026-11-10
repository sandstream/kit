import assert from "node:assert/strict";
import { join } from "node:path";
import { it } from "node:test";
import { InvalidConfigError, loadConfig } from "./config.js";
import { createCliContractFixture } from "./cli-contract.test-support.js";

const invalidLimits = [
  ["max_tokens_per_day", "-1"],
  ["max_tokens_per_day", "nan"],
  ["max_tokens_per_day", "inf"],
  ["max_operations_per_hour", "-1"],
  ["max_operations_per_hour", "1.5"],
  ["max_operations_per_hour", "9.007199254740992e15"],
  ["max_operations_per_hour", "nan"],
  ["max_operations_per_hour", "inf"],
];

for (const section of ["governance", "env.staging.governance"]) {
  for (const [field, value] of invalidLimits) {
    it(`refuses ${section}.agent.${field} = ${value}`, async (t) => {
      const fixture = createCliContractFixture(`[${section}.agent]\n${field} = ${value}\n`);
      t.after(() => fixture.cleanup());
      const before = fixture.snapshot();
      await assert.rejects(loadConfig(join(fixture.cwd, ".kit.toml"), "dev"), (error) => {
        assert.ok(error instanceof InvalidConfigError);
        assert.ok(error.message.includes(`${section}.agent.${field}`), error.message);
        return true;
      });
      assert.deepEqual(fixture.snapshot(), before);
    });
  }
}

it("CLI refuses a fractional operation limit before child execution or state writes", (t) => {
  const fixture = createCliContractFixture(
    '[governance]\nenabled = true\nenvironment = "dev"\n[governance.agent]\nmax_operations_per_hour = 1.5\n',
  );
  t.after(() => fixture.cleanup());
  const before = fixture.snapshot();
  const result = fixture.run([
    "run",
    "--",
    process.execPath,
    "-e",
    "console.log('INVALID_LIMIT_CHILD')",
  ]);
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /INVALID_LIMIT_CHILD/);
  assert.match(result.stderr, /Could not read or validate project configuration/);
  assert.deepEqual(fixture.snapshot(), before);
});

it("accepts zero limits, fractional token estimates, and the largest exact operation limit", async (t) => {
  for (const [tokens, operations] of [
    [0, 0],
    [0.5, Number.MAX_SAFE_INTEGER],
  ]) {
    const fixture = createCliContractFixture(
      `[governance.agent]\nmax_tokens_per_day = ${tokens}\nmax_operations_per_hour = ${operations}\n`,
    );
    t.after(() => fixture.cleanup());
    const config = await loadConfig(join(fixture.cwd, ".kit.toml"));
    assert.equal(config.governance?.agent?.max_tokens_per_day, tokens);
    assert.equal(config.governance?.agent?.max_operations_per_hour, operations);
  }
});
