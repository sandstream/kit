import assert from "node:assert/strict";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { InvalidConfigError, loadConfig } from "./config.js";
import { createCliContractFixture } from "./cli-contract.test-support.js";

function loadFixture(t: TestContext, contents: string, environment = "staging") {
  const fixture = createCliContractFixture(contents);
  t.after(() => fixture.cleanup());
  return loadConfig(join(fixture.cwd, ".kit.toml"), environment);
}

const invalidOverrides = [
  { contents: 'env = "staging"', path: "env" },
  { contents: "[env]\nstaging = false", path: "env.staging" },
  { contents: "[env.staging.tools]\nnode = 22", path: "env.staging.tools.node" },
  {
    contents: '[env.staging.services.api]\nlogin = "fixture login"\ncheck = false',
    path: "env.staging.services.api.check",
  },
  {
    contents: '[env.staging.services.api]\ncheck = "fixture check"',
    path: "env.staging.services.api.login",
  },
  { contents: '[env.staging.secrets]\nstore = "invalid"', path: "env.staging.secrets.store" },
  {
    contents: '[env.staging.secrets.keys.API_TOKEN]\nref = "fixture"',
    path: "env.staging.secrets.keys.API_TOKEN.source",
  },
  { contents: "[env.staging.skills]\nregistry = 42", path: "env.staging.skills.registry" },
  { contents: "[env.staging.governance]\nenabled = 0", path: "env.staging.governance.enabled" },
  {
    contents: '[env.staging.governance.access.dev]\nread = true\nwrite = "false"\ndelete = false',
    path: "env.staging.governance.access.dev.write",
  },
  {
    contents: '[env.staging.governance.agent]\nmax_operations_per_hour = "two"',
    path: "env.staging.governance.agent.max_operations_per_hour",
  },
];

for (const { contents, path } of invalidOverrides) {
  it(`loadConfig rejects invalid override ${path} with a configuration error`, async (t) => {
    await assert.rejects(loadFixture(t, contents), (error: unknown) => {
      assert.ok(error instanceof InvalidConfigError);
      assert.equal(error.code, "KIT_INVALID_CONFIG");
      assert.ok(error.message.includes(path), error.message);
      return true;
    });
  });
}

for (const environment of ["dev", "preview", "production"]) {
  it(`loadConfig validates the unselected ${environment} override`, async (t) => {
    await assert.rejects(
      loadFixture(t, `[env.${environment}.governance]\nenabled = 0`),
      InvalidConfigError,
    );
  });
}

it("loadConfig does not let a valid override conceal an invalid base", async (t) => {
  await assert.rejects(
    loadFixture(t, "[governance]\nenabled = 0\n[env.staging.governance]\nenabled = true"),
    InvalidConfigError,
  );
});

it("loadConfig accepts partial overrides and preserves section replacement and service merge", async (t) => {
  const config = await loadFixture(
    t,
    `[tools]
node = "22"
pnpm = "9"
[services.api]
login = "old login"
check = "old check"
link = "old link"
[services.retained]
login = "retained login"
check = "retained check"
[secrets]
store = "env"
template = "base.template"
[skills]
registry = "base-registry"
[skills.required]
base = "1"
[governance]
enabled = true
environment = "dev"
[hooks]
pre-commit = ["fixture check"]
[env.staging.tools]
node = "24"
[env.staging.services.api]
login = "new login"
check = "new check"
[env.staging.services.added]
login = "added login"
check = "added check"
[env.staging.secrets]
template = "staging.template"
[env.staging.skills]
registry = "staging-registry"
[env.staging.governance]
enabled = false
`,
  );
  assert.deepEqual(config.tools, { node: "24" });
  assert.deepEqual(config.services, {
    api: { login: "new login", check: "new check" },
    retained: { login: "retained login", check: "retained check" },
    added: { login: "added login", check: "added check" },
  });
  assert.deepEqual(config.secrets, { template: "staging.template" });
  assert.deepEqual(config.skills, { registry: "staging-registry" });
  assert.deepEqual(config.governance, { enabled: false });
  assert.deepEqual(config.hooks, { "pre-commit": ["fixture check"] });
});

it("loadConfig preserves base sections omitted from a partial override", async (t) => {
  const config = await loadFixture(
    t,
    '[tools]\nnode = "22"\n[governance]\nenabled = true\n[env.staging.secrets]\nstore = "env"',
  );
  assert.deepEqual(config.tools, { node: "22" });
  assert.deepEqual(config.governance, { enabled: true });
  assert.deepEqual(config.secrets, { store: "env" });
});

it("loadConfig accepts an override that only changes an optional nested section", async (t) => {
  const config = await loadFixture(
    t,
    "[env.staging.governance.agent]\nmax_operations_per_hour = 2",
  );
  assert.deepEqual(config.governance, { agent: { max_operations_per_hour: 2 } });
});

it("loadConfig keeps base configuration for empty, missing, and dev overrides", async (t) => {
  for (const environment of ["staging", "missing", "dev"]) {
    const config = await loadFixture(
      t,
      '[tools]\nnode = "22"\n[env.staging]\n[env.dev.tools]\nnode = "24"',
      environment,
    );
    assert.deepEqual(config.tools, { node: "22" });
  }
});

it("loadConfig preserves unknown override fields without applying unsupported sections", async (t) => {
  const config = await loadFixture(
    t,
    '[hooks]\npre-commit = ["base"]\n[env.team-blue]\nfuture = "kept"\n[env.team-blue.hooks]\npre-commit = ["override"]',
    "team-blue",
  );
  assert.deepEqual(config.hooks, { "pre-commit": ["base"] });
  assert.deepEqual(JSON.parse(JSON.stringify(config.env?.["team-blue"])), {
    future: "kept",
    hooks: { "pre-commit": ["override"] },
  });
});
