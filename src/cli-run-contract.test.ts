import assert from "node:assert/strict";
import { afterEach, beforeEach, it } from "node:test";
import { createCliContractFixture } from "./cli-contract.test-support.js";

let fixture: ReturnType<typeof createCliContractFixture>;
beforeEach(() => {
  fixture = createCliContractFixture();
});
afterEach(() => fixture.cleanup());

for (const code of [0, 7, 42, 124]) {
  it(`preserves the child exit status ${code}`, () => {
    const result = fixture.run(["run", "--", process.execPath, "-e", `process.exit(${code})`]);
    assert.equal(result.status, code, result.stderr);
  });
}

it("reports command-not-found as 127", () => {
  const result = fixture.run(["run", "--", "kit-absent-contract-command"]);
  assert.equal(result.status, 127, result.stderr);
});

for (const flag of [
  "--help",
  "--version",
  "--read-only",
  "--readonly",
  "--env=production",
  "--dry-run",
]) {
  it(`passes the child's ${flag} argument without treating it as a Kit flag`, () => {
    const result = fixture.run([
      "run",
      "--",
      process.execPath,
      "-e",
      "console.log('CHILD_ARGS=' + JSON.stringify(process.argv.slice(1)))",
      "--",
      flag,
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`CHILD_ARGS=\\["${flag}"\\]`));
  });
}

it("keeps leading Kit flags out of child arguments", () => {
  const result = fixture.run([
    "--non-interactive",
    "run",
    "--",
    process.execPath,
    "-e",
    "console.log('CHILD_ARGS=' + JSON.stringify(process.argv.slice(1)))",
    "--",
    "kept",
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /CHILD_ARGS=\["kept"\]/);
});
