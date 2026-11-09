import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { createCliContractFixture } from "./cli-contract.test-support.js";
import { buildOpenCliDoc } from "./opencli.js";

for (const args of [
  ["guard", "status", "--all"],
  ["guard", "install", "--name-only"],
  ["guard-observe", "--all", "git", "clone", "https://github.com/example/repo"],
  ["guard-observe", "--no-deps", "--", "git", "clone", "https://github.com/example/repo"],
]) {
  it(`refuses an unrelated Kit option before effects: ${args.join(" ")}`, (t) => {
    const fixture = createCliContractFixture();
    t.after(() => fixture.cleanup());
    fixture.env.KIT_GUARD_DIR = join(fixture.root, "shims");
    fixture.env.KIT_GUARD_LOG = join(fixture.root, "observations.jsonl");
    fixture.env.KIT_GUARD_RC = join(fixture.root, "shellrc");
    const before = fixture.snapshot();
    const result = fixture.run(args);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /unknown flag/);
    assert.deepEqual(fixture.snapshot(), before);
  });
}

it("retains the same flags when they belong to the observed tool", (t) => {
  const fixture = createCliContractFixture();
  t.after(() => fixture.cleanup());
  const log = join(fixture.root, "observations.jsonl");
  fixture.env.KIT_GUARD_LOG = log;
  fixture.env.KIT_GUARD_DIR = join(fixture.root, "shims");
  const command = ["git", "clone", "https://github.com/example/repo", "--all", "--no-deps"];
  const result = fixture.run(["guard-observe", "--non-interactive", ...command]);
  assert.equal(result.status, 0, result.stderr);
  const row = JSON.parse(readFileSync(log, "utf8"));
  assert.equal(row.command, command.join(" "));
});

it("publishes only global Kit flags for the guard commands", () => {
  const commands = buildOpenCliDoc().commands;
  const expected = [
    "--env",
    "--help",
    "--non-interactive",
    "--read-only",
    "--readonly",
    "--version",
  ];
  for (const verb of ["guard", "guard-observe"]) {
    assert.deepEqual(commands[verb]["x-kit-accepted-flags"], expected);
  }
});
