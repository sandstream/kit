import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { createCliContractFixture } from "./cli-contract.test-support.js";

let fixture: ReturnType<typeof createCliContractFixture>;
let log: string;
beforeEach(() => {
  fixture = createCliContractFixture();
  log = join(fixture.root, "observations.jsonl");
  fixture.env.KIT_GUARD_LOG = log;
  fixture.env.KIT_GUARD_DIR = join(fixture.root, "shims");
});
afterEach(() => fixture.cleanup());

function observations() {
  assert.ok(existsSync(log), "an install observation must reach the log");
  return readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line) as {
          command: string;
          tool: string;
          cwd: string;
          wouldBlock: boolean;
        },
    );
}

const install = ["npm", "install", "kit-contract-fixture@1.0.0"];
for (const flag of [
  "--help",
  "-h",
  "--version",
  "--read-only",
  "--read-only=false",
  "--readonly=0",
  "--env",
  "--env=staging",
  "--save-dev",
  "--registry=https://registry.example.invalid",
  "--dry-run",
]) {
  it(`observes the tool's ${flag} without treating it as a Kit option`, () => {
    const command = [...install, flag];
    const result = fixture.run(["guard-observe", ...command]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    const rows = observations();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].command, command.join(" "));
    assert.equal(rows[0].tool, "npm");
    assert.equal(rows[0].cwd, realpathSync(fixture.cwd));
    assert.equal(typeof rows[0].wouldBlock, "boolean");
    assert.equal(
      existsSync(join(fixture.cwd, ".kit-audit.jsonl")),
      false,
      "child options cannot activate Kit policy state",
    );
  });
}

it("accepts an explicit separator before the observed tool", () => {
  const result = fixture.run(["guard-observe", "--", ...install, "--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(observations()[0].command, [...install, "--help"].join(" "));
});

it("keeps Kit help before the observed tool free of effects", () => {
  const before = fixture.snapshot();
  const result = fixture.run(["guard-observe", "--help", ...install]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /kit guard-observe/);
  assert.deepEqual(fixture.snapshot(), before);
});

it("rejects a malformed Kit option before the separator without an observation", () => {
  const before = fixture.snapshot();
  const result = fixture.run(["guard-observe", "--read-only=false", "--", ...install]);
  assert.equal(result.status, 2, result.stderr);
  assert.deepEqual(fixture.snapshot(), before);
});

it("keeps leading Kit environment flags out of the recorded tool arguments", () => {
  const result = fixture.run(["--env", "staging", "guard-observe", ...install]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(observations()[0].command, install.join(" "));
});

it("records each repeated observation without executing a package manager", () => {
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = fixture.run(["guard-observe", ...install]);
    assert.equal(result.status, 0, result.stderr);
  }
  assert.deepEqual(
    observations().map((row) => row.command),
    [install.join(" "), install.join(" ")],
  );
  assert.equal(existsSync(join(fixture.cwd, "node_modules")), false);
  assert.equal(existsSync(join(fixture.cwd, "package-lock.json")), false);
});

it("keeps observation failure nonblocking when the log cannot be written", () => {
  const file = join(fixture.root, "parent-file");
  writeFileSync(file, "keep");
  fixture.env.KIT_GUARD_LOG = join(file, "observations.jsonl");
  const result = fixture.run(["guard-observe", ...install]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(file, "utf8"), "keep");
  assert.equal(existsSync(log), false);
  assert.equal(existsSync(join(fixture.cwd, "node_modules")), false);
  assert.equal(existsSync(join(fixture.cwd, "package-lock.json")), false);
});

it("masks clone URL credentials before writing the observation", () => {
  const secret = "fixture-private-password";
  const result = fixture.run([
    "guard-observe",
    "git",
    "clone",
    `https://fixture:${secret}@github.com/example/repository.git`,
  ]);
  assert.equal(result.status, 0, result.stderr);
  const contents = readFileSync(log, "utf8");
  assert.ok(
    !contents.includes(secret),
    "command, reason, and refs must not contain URL credentials",
  );
  assert.match(contents, /REDACTED/);
  assert.match(contents, /github.com/);
});
