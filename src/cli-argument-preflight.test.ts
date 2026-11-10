import assert from "node:assert/strict";
import { it } from "node:test";
import { createCliContractFixture } from "./cli-contract.test-support.js";

const policy = 'version = 1\n[policy]\ndefault_mode = "read-only"\n';

for (const args of [
  ["governance", "unexpected"],
  ["governance", "status", "extra"],
  ["governance", "status", "status"],
  ["governance", "--", "child"],
  ["governance", "-x"],
]) {
  it(`refuses unexpected governance arguments before policy effects: ${args.join(" ")}`, (t) => {
    const fixture = createCliContractFixture(policy);
    t.after(() => fixture.cleanup());
    const before = fixture.snapshot();
    const result = fixture.run(args);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stderr, /usage: kit governance/);
    assert.deepEqual(fixture.snapshot(), before);
  });
}

for (const flag of ["--broker-gate", "--limit=1", "--no-install-gate", "--json"]) {
  it(`governance refuses the unrelated option ${flag} before policy effects`, (t) => {
    const fixture = createCliContractFixture(policy);
    t.after(() => fixture.cleanup());
    const before = fixture.snapshot();
    const result = fixture.run(["governance", flag]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /unknown flag/);
    assert.equal(result.stdout, "");
    assert.deepEqual(fixture.snapshot(), before);
  });
}

for (const args of [
  ["whoami", "extra"],
  ["whoami", "--json", "false"],
  ["whoami", "--", "extra"],
  ["whoami", "-x"],
]) {
  it(`refuses unexpected whoami arguments before policy effects: ${args.join(" ")}`, (t) => {
    const fixture = createCliContractFixture(policy);
    t.after(() => fixture.cleanup());
    const before = fixture.snapshot();
    const result = fixture.run(args);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stderr, /usage: kit whoami/);
    assert.deepEqual(fixture.snapshot(), before);
  });
}

it("refuses an unknown declared-command flag before policy audit writes", (t) => {
  const fixture = createCliContractFixture(policy);
  t.after(() => fixture.cleanup());
  const before = fixture.snapshot();
  const result = fixture.run(["whoami", "--unknown-option"]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /unknown flag/);
  assert.equal(result.stdout, "");
  assert.deepEqual(fixture.snapshot(), before);
});

it("unknown flag diagnostics do not expose credentials or terminal controls", (t) => {
  const fixture = createCliContractFixture();
  t.after(() => fixture.cleanup());
  const token = ["ghp", "x".repeat(36)].join("_");
  const result = fixture.run(["whoami", `--${token}\u001b[2J`]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /unknown flag/);
  assert.equal(result.stderr.includes(token), false);
  assert.equal(result.stderr.includes("\u001b[2J"), false);
});

for (const command of ["gate-bash", "gate-env", "gate-egress", "gate-fs"]) {
  for (const flag of ["--unknown-option", "-x"]) {
    it(`${command} denies ${flag} with the hook protocol's blocking exit code`, (t) => {
      const fixture = createCliContractFixture(policy);
      t.after(() => fixture.cleanup());
      const before = fixture.snapshot();
      const result = fixture.run([command, flag]);
      assert.equal(result.status, 2, result.stdout + result.stderr);
      assert.match(result.stderr, /unknown flag/);
      assert.equal(result.stdout, "");
      assert.deepEqual(fixture.snapshot(), before);
    });
  }
}

it("the documented governance status alias retains the bare command behavior", (t) => {
  const fixture = createCliContractFixture();
  t.after(() => fixture.cleanup());
  const before = fixture.snapshot();
  const bare = fixture.run(["governance"]);
  const alias = fixture.run(["governance", "status"]);
  const withEnvironment = fixture.run(["governance", "--env", "dev", "status"]);
  assert.equal(bare.status, 0, bare.stderr);
  assert.match(bare.stdout, /Governance Status/);
  for (const result of [alias, withEnvironment]) {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, bare.stdout);
  }
  assert.deepEqual(fixture.snapshot(), before);
});
