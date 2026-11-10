import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { createCliContractFixture } from "./cli-contract.test-support.js";
import { buildOpenCliDoc } from "./opencli.js";
import { installAttemptRecorder } from "./cli-install-tripwire.test-support.js";

const child = [
  process.execPath,
  "-e",
  "require('node:fs').writeFileSync('child-result.json', JSON.stringify(process.argv.slice(1)))",
  "--",
  "--minimal",
];
const sarif = {
  version: "2.1.0",
  runs: [
    {
      tool: { driver: { name: "contract-scanner" } },
      results: [{ ruleId: "CONTRACT-001", level: "warning", message: { text: "fixture finding" } }],
    },
  ],
};
const cases = [
  { verb: "whoami", own: ["--json"], args: ["whoami", "--json"], wrong: "--mode" },
  {
    verb: "ingest",
    own: ["--json"],
    args: ["ingest", "sarif", "report.sarif", "--json"],
    wrong: "--attest",
  },
  {
    verb: "create-plugin",
    own: ["--skip-install"],
    args: ["create-plugin", "contract-probe", "--skip-install"],
    wrong: "--no-setup",
  },
  { verb: "run", own: [], args: ["run", "--", ...child], wrong: "--minimal" },
  { verb: "open", own: [], args: ["open"], wrong: "--json" },
];

for (const { verb, args, own, wrong } of cases) {
  it(`${verb} refuses a sibling or imported program flag before effects`, (t) => {
    const fixture = createCliContractFixture();
    t.after(() => fixture.cleanup());
    writeFileSync(join(fixture.cwd, "report.sarif"), JSON.stringify(sarif));
    const before = fixture.snapshot();
    const result = fixture.run([verb, wrong, ...args.slice(1)]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /unknown flag/);
    assert.equal(result.stdout, "");
    assert.deepEqual(fixture.snapshot(), before);
  });

  it(`${verb} retains its declared behavior`, (t) => {
    const fixture = createCliContractFixture();
    t.after(() => fixture.cleanup());
    writeFileSync(join(fixture.cwd, "report.sarif"), JSON.stringify(sarif));
    const attempts = verb === "create-plugin" ? installAttemptRecorder(fixture) : null;
    const before = fixture.snapshot();
    const result = fixture.run(args);
    assert.equal(result.status, 0, result.stderr);
    if (verb === "whoami") {
      const value = JSON.parse(result.stdout);
      assert.equal(value.agent, null);
      assert.equal(value.budget, null);
      assert.equal(typeof value.environment, "string");
    } else if (verb === "ingest") {
      const value = JSON.parse(result.stdout);
      assert.equal(value.count, 1);
      assert.equal(value.findings[0].name, "contract-scanner: CONTRACT-001");
      assert.equal(value.findings[0].detail, "fixture finding");
    } else if (verb === "create-plugin") {
      const root = join(fixture.cwd, "kit-plugin-contract-probe");
      assert.equal(
        JSON.parse(readFileSync(join(root, "package.json"), "utf8")).name,
        "kit-plugin-contract-probe",
      );
      assert.equal(existsSync(join(root, "node_modules")), false);
      assert.equal(existsSync(join(root, "package-lock.json")), false);
      assert.equal(readFileSync(attempts!, "utf8"), "", "skip-install must not attempt execution");
      assert.doesNotMatch(result.stdout, /triage blocked|Dependency install failed/);
      const after = fixture.snapshot();
      for (const path of Object.keys(after)) {
        if (path.startsWith(join("project", "kit-plugin-contract-probe"))) delete after[path];
      }
      assert.deepEqual(
        after,
        before,
        "skip-install must not provision triage or change machine state",
      );
    } else if (verb === "run") {
      assert.deepEqual(JSON.parse(readFileSync(join(fixture.cwd, "child-result.json"), "utf8")), [
        "--minimal",
      ]);
    } else {
      assert.match(result.stdout, /Available services:/);
    }
  });

  it(`${verb} publishes only its own flags and global flags`, () => {
    const globals = [
      "--env",
      "--help",
      "--non-interactive",
      "--read-only",
      "--readonly",
      "--version",
    ];
    assert.deepEqual(
      buildOpenCliDoc().commands[verb]["x-kit-accepted-flags"],
      [...globals, ...own].sort(),
    );
  });
}

it("the installation recorder catches the CLI's default triage attempt without executing it", (t) => {
  const fixture = createCliContractFixture();
  t.after(() => fixture.cleanup());
  const marker = installAttemptRecorder(fixture);
  const result = fixture.run(["create-plugin", "contract-probe"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(marker, "utf8"), /python3/);
  assert.match(result.stdout, /triage blocked/);
  assert.equal(existsSync(join(fixture.cwd, "kit-plugin-contract-probe", "node_modules")), false);
});
