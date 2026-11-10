import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { createCliContractFixture } from "./cli-contract.test-support.js";
import { installAttemptRecorder } from "./cli-install-tripwire.test-support.js";

const commands = [
  { args: ["whoami"], flag: "--json" },
  { args: ["ingest", "sarif", "report.sarif"], flag: "--json" },
  { args: ["create-plugin", "contract-probe"], flag: "--skip-install" },
];

for (const { args, flag } of commands) {
  for (const value of ["true", "false", ""]) {
    it(`${args[0]} refuses ${flag}=${value} before command or policy effects`, (t) => {
      const fixture = createCliContractFixture(
        'version = 1\n[policy]\ndefault_mode = "read-only"\n',
      );
      t.after(() => fixture.cleanup());
      writeFileSync(
        join(fixture.cwd, "report.sarif"),
        JSON.stringify({ version: "2.1.0", runs: [] }),
      );
      const marker = installAttemptRecorder(fixture);
      const before = fixture.snapshot();
      const result = fixture.run([...args, `${flag}=${value}`]);
      assert.equal(result.status, 2, result.stdout + result.stderr);
      assert.match(result.stderr, new RegExp(`${flag} does not accept a value`));
      assert.equal(result.stdout, "");
      assert.equal(readFileSync(marker, "utf8"), "");
      assert.deepEqual(fixture.snapshot(), before);
    });
  }
}

it("rejects a skip-install value before creating a scaffold in writable mode", (t) => {
  const fixture = createCliContractFixture();
  t.after(() => fixture.cleanup());
  const marker = installAttemptRecorder(fixture);
  const before = fixture.snapshot();
  const result = fixture.run(["create-plugin", "contract-probe", "--skip-install=true"]);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.equal(readFileSync(marker, "utf8"), "");
  assert.deepEqual(fixture.snapshot(), before);
});

it("preserves inline flag values in the run child arguments", (t) => {
  const fixture = createCliContractFixture();
  t.after(() => fixture.cleanup());
  const expected = ["--json=true", "--skip-install=false"];
  const result = fixture.run([
    "run",
    "--",
    process.execPath,
    "-e",
    "console.log(JSON.stringify(process.argv.slice(1)))",
    "--",
    ...expected,
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), expected);
});

it("preserves inline flag values after the observed tool name", (t) => {
  const fixture = createCliContractFixture();
  t.after(() => fixture.cleanup());
  const log = join(fixture.root, "observations.jsonl");
  fixture.env.KIT_GUARD_LOG = log;
  fixture.env.KIT_GUARD_DIR = join(fixture.root, "shims");
  const command = [
    "git",
    "clone",
    "https://github.com/example/repo",
    "--json=true",
    "--skip-install=false",
  ];
  const result = fixture.run(["guard-observe", ...command]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(readFileSync(log, "utf8")).command, command.join(" "));
});
