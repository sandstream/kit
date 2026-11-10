import assert from "node:assert/strict";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { createCliContractFixture } from "./cli-contract.test-support.js";

it("whoami supports a project without configuration and does not create it", (t) => {
  const fixture = createCliContractFixture();
  t.after(() => fixture.cleanup());
  rmSync(join(fixture.cwd, ".kit.toml"));
  const before = fixture.snapshot();
  const result = fixture.run(["whoami", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    agent: null,
    environment: "dev",
    environment_source: "default",
    config_environment: "dev",
    budget: null,
  });
  assert.deepEqual(fixture.snapshot(), before);
});

it("whoami refuses a configuration path that is a directory", (t) => {
  const fixture = createCliContractFixture();
  t.after(() => fixture.cleanup());
  const path = join(fixture.cwd, ".kit.toml");
  rmSync(path);
  mkdirSync(path);
  const before = fixture.snapshot();
  const result = fixture.run(["whoami"]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /configuration/i);
  assert.equal(result.stdout, "");
  assert.deepEqual(fixture.snapshot(), before);
});

it("whoami refuses an existing configuration link with no target", (t) => {
  const fixture = createCliContractFixture();
  t.after(() => fixture.cleanup());
  const path = join(fixture.cwd, ".kit.toml");
  rmSync(path);
  try {
    symlinkSync(join(fixture.root, "absent.toml"), path, "file");
  } catch (error) {
    if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("Expected: this Windows account cannot create the required file-link fixture.");
      return;
    }
    throw error;
  }
  const result = fixture.run(["whoami", "--json"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).ok, false);
  assert.match(result.stderr, /configuration/i);
});

it("whoami reports no identity when the agent section contains only limits", (t) => {
  const fixture = createCliContractFixture(`version = 1
[governance.agent]
max_tokens_per_day = 7
`);
  t.after(() => fixture.cleanup());
  const result = fixture.run(["whoami", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).agent, null);
});

for (const json of [false, true]) {
  it(`whoami protects displayed profile fields from secrets and terminal controls, json=${json}`, (t) => {
    const fixture = createCliContractFixture();
    t.after(() => fixture.cleanup());
    const token = ["ghp", "x".repeat(36)].join("_");
    writeFileSync(
      join(fixture.cwd, ".kit.toml"),
      `version = 1
[governance.agent]
id = "public-agent"
name = "Public Name \\u001b[2J${token}"
`,
    );
    const before = fixture.snapshot();
    const result = fixture.run(["whoami", ...(json ? ["--json"] : [])]);
    assert.equal(result.status, 0, result.stderr);
    const name = json ? JSON.parse(result.stdout).agent.name : result.stdout;
    assert.equal(name.includes(token), false);
    assert.equal(name.includes("\u001b[2J"), false);
    assert.match(name, /Public Name/);
    assert.match(result.stdout, /public-agent/);
    assert.deepEqual(fixture.snapshot(), before);
  });
}
