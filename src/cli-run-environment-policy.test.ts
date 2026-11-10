import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { createCliContractFixture } from "./cli-contract.test-support.js";

const deniedConfig = `[governance]
enabled = true
environment = "dev"
[governance.access.dev]
read = true
write = false
delete = false
[governance.audit]
enabled = false
remote = false
[governance.revocation]
enabled = false
[governance.secrets]
check_expiration = false
`;

it("CLI run refuses an invalid selected governance override before child effects", (t) => {
  const fixture = createCliContractFixture(
    `${deniedConfig}\n[env.staging.governance]\nenabled = 0\n`,
  );
  t.after(() => fixture.cleanup());
  const marker = join(fixture.cwd, "child-ran");
  const result = fixture.run([
    "run",
    "--env",
    "staging",
    "--",
    process.execPath,
    "-e",
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`,
  ]);
  assert.equal(existsSync(marker), false, "invalid configuration must prevent child effects");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Could not read or validate project configuration/);
  assert.match(result.stderr, /Could not read or validate project configuration/);
});

it("CLI run also validates an override selected through KIT_ENV", (t) => {
  const fixture = createCliContractFixture("[env.staging.governance]\nenabled = 0\n");
  t.after(() => fixture.cleanup());
  fixture.env.KIT_ENV = "staging";
  const marker = join(fixture.cwd, "child-ran");
  const result = fixture.run([
    "run",
    "--",
    process.execPath,
    "-e",
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`,
  ]);
  assert.equal(existsSync(marker), false);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Could not read or validate project configuration/);
});

it("CLI run refuses an invalid unselected override before child effects", (t) => {
  const fixture = createCliContractFixture("[env.production.governance]\nenabled = 0\n");
  t.after(() => fixture.cleanup());
  const marker = join(fixture.cwd, "child-ran");
  const result = fixture.run([
    "run",
    "--env=staging",
    "--",
    process.execPath,
    "-e",
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`,
  ]);
  assert.equal(existsSync(marker), false);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Could not read or validate project configuration/);
});

it("CLI run accepts a valid partial override with an explicit governance opt-out", (t) => {
  const fixture = createCliContractFixture(
    `${deniedConfig}\n[env.staging.governance]\nenabled = false\n`,
  );
  t.after(() => fixture.cleanup());
  const marker = join(fixture.cwd, "child-ran");
  const result = fixture.run([
    "run",
    "--env=staging",
    "--",
    process.execPath,
    "-e",
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started'); process.exit(7)`,
  ]);
  assert.equal(result.status, 7, result.stderr);
  assert.equal(readFileSync(marker, "utf8"), "started");
  assert.doesNotMatch(result.stderr, /Could not read or validate project configuration/);
});

for (const override of ["[env.staging]\n", '[env.staging.secrets]\nstore = "env"\n']) {
  it(`CLI run preserves base refusal with valid partial override ${override.trim()}`, (t) => {
    const fixture = createCliContractFixture(`${deniedConfig}\n${override}`);
    t.after(() => fixture.cleanup());
    const marker = join(fixture.cwd, "child-ran");
    const result = fixture.run([
      "run",
      "--env",
      "staging",
      "--",
      process.execPath,
      "-e",
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`,
    ]);
    assert.equal(existsSync(marker), false);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not allowed|denied/i);
    assert.doesNotMatch(result.stderr, /Could not read or validate project configuration/);
  });
}
