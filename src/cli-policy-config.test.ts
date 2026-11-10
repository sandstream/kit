import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { createCliContractFixture } from "./cli-contract.test-support.js";

const policy = '[policy]\ndefault_mode = "read-only"\n';
const invalid = [
  policy + "[governance.agent]\nmax_operations_per_hour = 1.5\n",
  policy + "[env.staging.governance.agent]\nmax_tokens_per_day = -1\n",
  'unclosed = "CONFIG_SECRET_SENTINEL',
];

for (const [index, config] of invalid.entries()) {
  for (const flags of [[], ["--read-only"]]) {
    it(`invalid config ${index} cannot enroll or replace a secret (${flags.join(" ")})`, (t) => {
      const fixture = createCliContractFixture(config);
      t.after(() => fixture.cleanup());
      mkdirSync(join(fixture.env.HOME!, ".kit"));
      writeFileSync(join(fixture.env.HOME!, ".kit/totp-secret"), "UNCHANGED_SENTINEL");
      const before = fixture.snapshot();
      const result = fixture.run(["auth", "setup-totp", "--overwrite", ...flags]);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stderr, /Could not read or validate project configuration/);
      assert.doesNotMatch(
        result.stdout + result.stderr,
        /CONFIG_SECRET_SENTINEL|UNCHANGED_SENTINEL/,
      );
      assert.deepEqual(fixture.snapshot(), before);
    });
  }
}

it("unreadable configuration cannot start enrollment", (t) => {
  const fixture = createCliContractFixture();
  t.after(() => fixture.cleanup());
  rmSync(join(fixture.cwd, ".kit.toml"));
  mkdirSync(join(fixture.cwd, ".kit.toml"));
  const before = fixture.snapshot();
  const result = fixture.run(["auth", "setup-totp"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.deepEqual(fixture.snapshot(), before);
});

it("invalid configuration returns structured refusal and blocks hook gates", (t) => {
  const fixture = createCliContractFixture(invalid[0]);
  t.after(() => fixture.cleanup());
  const before = fixture.snapshot();
  const status = fixture.run(["auth", "status", "--json"]);
  assert.equal(status.status, 1);
  assert.deepEqual(JSON.parse(status.stdout), {
    ok: false,
    error: "Could not read or validate project configuration. Check .kit.toml.",
  });
  const gate = fixture.run(["gate-bash"]);
  assert.equal(gate.status, 2, gate.stdout + gate.stderr);
  assert.deepEqual(fixture.snapshot(), before);
});

for (const [label, config, exit] of [
  ["read-only", policy + "[governance.agent]\nmax_operations_per_hour = 1\n", 1],
  ["writable", "version = 1\n", 0],
  ["absent", "", 0],
] as const) {
  it(`valid ${label} configuration retains its enrollment behavior`, (t) => {
    const fixture = createCliContractFixture(config);
    t.after(() => fixture.cleanup());
    if (label === "absent") rmSync(join(fixture.cwd, ".kit.toml"));
    const result = fixture.run(["auth", "setup-totp", "--account=synthetic@example.invalid"]);
    assert.equal(result.status, exit, result.stdout + result.stderr);
    assert.equal(existsSync(join(fixture.env.HOME!, ".kit/totp-secret")), exit === 0);
  });
}
