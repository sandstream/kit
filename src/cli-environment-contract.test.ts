import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { createCliContractFixture } from "./cli-contract.test-support.js";

const config = `version = 1
[secrets.keys.CONTRACT_MODE]
source = "config"
value = "base"
[env.staging.secrets.keys.CONTRACT_MODE]
source = "config"
value = "staging"
`;
let fixture: ReturnType<typeof createCliContractFixture>;
beforeEach(() => {
  fixture = createCliContractFixture(config);
});
afterEach(() => fixture.cleanup());

for (const args of [
  ["secrets", "--env=staging"],
  ["secrets", "--env", "staging"],
  ["--env=staging", "secrets"],
  ["--env", "staging", "secrets"],
]) {
  it(`selects the named environment for ${args.join(" ")}`, () => {
    const result = fixture.run(args);
    assert.equal(result.status, 0, result.stderr);
    const materialized = readFileSync(join(fixture.cwd, ".env.local"), "utf8");
    assert.match(materialized, /CONTRACT_MODE=staging/);
    assert.doesNotMatch(materialized, /CONTRACT_MODE=base/);
  });
}

for (const args of [
  ["secrets", "--env"],
  ["secrets", "--env="],
  ["secrets", "--env", "--json"],
  ["secrets", "--env=-bad"],
  ["--env=staging", "secrets", "--env=production"],
]) {
  it(`refuses invalid environment selection before writes: ${args.join(" ")}`, () => {
    const before = fixture.snapshot();
    const result = fixture.run(args);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /--env/);
    assert.deepEqual(fixture.snapshot(), before);
  });
}

it("does not use a forwarded environment flag to select Kit configuration", () => {
  const result = fixture.run(["secrets", "--", "--env=staging"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(join(fixture.cwd, ".env.local"), "utf8"), /CONTRACT_MODE=base/);
});

it("retains KIT_ENV selection when there is no Kit environment flag", () => {
  fixture.env.KIT_ENV = "staging";
  const result = fixture.run(["secrets"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(join(fixture.cwd, ".env.local"), "utf8"), /CONTRACT_MODE=staging/);
});

it("reports invalid environment selection as JSON when requested", () => {
  const before = fixture.snapshot();
  const result = fixture.run(["check", "--env", "--json"]);
  assert.equal(result.status, 2, result.stderr);
  const error = JSON.parse(result.stdout);
  assert.equal(error.ok, false);
  assert.match(error.error, /--env/);
  assert.deepEqual(fixture.snapshot(), before);
});
