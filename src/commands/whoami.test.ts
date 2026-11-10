import assert from "node:assert/strict";
import { it } from "node:test";
import { createCliContractFixture } from "../cli-contract.test-support.js";

it("whoami refuses invalid project configuration instead of reporting an absent identity", (t) => {
  const fixture = createCliContractFixture('[governance.agent\nname = "Broken profile"\n');
  t.after(() => fixture.cleanup());
  const before = fixture.snapshot();
  const result = fixture.run(["whoami", "--json"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const data = JSON.parse(result.stdout);
  assert.equal(data.ok, false);
  assert.match(data.error, /configuration/i);
  assert.equal(data.agent, undefined);
  assert.deepEqual(fixture.snapshot(), before);
});

it("whoami reports the enforced default budget when governance has no custom limits", (t) => {
  const fixture = createCliContractFixture("version = 1\n[governance]\nenabled = true\n");
  t.after(() => fixture.cleanup());
  const before = fixture.snapshot();
  const result = fixture.run(["whoami", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.equal(data.agent, null);
  assert.deepEqual(data.budget, {
    tokens_used: 0,
    tokens_limit: 1000000,
    operations_used: 0,
    operations_limit: 100,
  });
  assert.deepEqual(fixture.snapshot(), before);
});

it("whoami reports the selected configuration and the environment that governs access", (t) => {
  const fixture = createCliContractFixture(`version = 1
[env.staging.governance]
enabled = true
environment = "prod"
[env.staging.governance.agent]
id = "deployment-check"
name = "Deployment check"
`);
  t.after(() => fixture.cleanup());
  fixture.env.NODE_ENV = "development";
  const before = fixture.snapshot();
  const result = fixture.run(["whoami", "--env", "staging", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.deepEqual(data.agent, { id: "deployment-check", name: "Deployment check" });
  assert.equal(data.environment, "prod");
  assert.equal(data.environment_source, "config");
  assert.equal(data.config_environment, "staging");
  assert.deepEqual(fixture.snapshot(), before);
});
