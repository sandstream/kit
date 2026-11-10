import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { createCliContractFixture } from "./cli-contract.test-support.js";
import { SKIPPED_COMMITS_LOG } from "./hooks.js";

const version = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;
const child = [
  process.execPath,
  "-e",
  "require('node:fs').writeFileSync('child-result.json', JSON.stringify(process.argv.slice(1)))",
  "--",
];
const globals = ["--help", "--version", "--non-interactive"];

for (const flag of globals) {
  for (const value of ["true", "false", ""]) {
    for (const position of ["leading", "command"]) {
      it(`refuses ${position} ${flag}=${value} before child execution`, (t) => {
        const fixture = createCliContractFixture();
        t.after(() => fixture.cleanup());
        delete fixture.env.CI;
        delete fixture.env.KIT_NON_INTERACTIVE;
        const own =
          position === "leading" ? [`${flag}=${value}`, "run"] : ["run", `${flag}=${value}`];
        const before = fixture.snapshot();
        const result = fixture.run([...own, "--", ...child]);
        assert.equal(result.status, 2, result.stdout + result.stderr);
        assert.match(result.stderr, new RegExp(`${flag} does not accept a value`));
        assert.equal(result.stdout, "");
        assert.deepEqual(fixture.snapshot(), before);
      });
    }
  }
}

for (const own of [["version"], ["-v"], ["--version"], ["run", "--version"]]) {
  for (const extra of [[], ["--env", "--read-only=false", "--non-interactive=false"]]) {
    it(`${own.join(" ")} precedes policy activation and invalid globals ${extra.length > 0}`, (t) => {
      const fixture = createCliContractFixture(
        'version = 1\n[policy]\ndefault_mode = "read-only"\n',
      );
      t.after(() => fixture.cleanup());
      // Expected: version output is informational and precedes the bypass banner.
      fixture.env.KIT_HIDE_HOOK_SKIP_BANNER = "0";
      writeFileSync(
        join(fixture.cwd, SKIPPED_COMMITS_LOG),
        JSON.stringify({
          timestamp: "2026-11-05T10:00:00Z",
          sha: "a".repeat(40),
          reason: "sentinel-missing",
        }) + "\n",
      );
      const before = fixture.snapshot();
      const result = fixture.run([...own, ...extra, "--", ...child]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, `${version}\n`);
      assert.doesNotMatch(result.stderr, /bypassed pre-commit hook/);
      assert.deepEqual(fixture.snapshot(), before);
    });
  }
}

it("bare help retains precedence over version and invalid globals without effects", (t) => {
  const fixture = createCliContractFixture('version = 1\n[policy]\ndefault_mode = "read-only"\n');
  t.after(() => fixture.cleanup());
  const before = fixture.snapshot();
  const result = fixture.run([
    "run",
    "--help",
    "--version",
    "--env",
    "--read-only=false",
    "--help=true",
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /kit run/);
  assert.deepEqual(fixture.snapshot(), before);
});

it("passes bare and inline globals through the child boundary unchanged", (t) => {
  const fixture = createCliContractFixture();
  t.after(() => fixture.cleanup());
  const expected = [
    "--help=true",
    "--version=false",
    "--non-interactive=",
    "--version",
    "--help",
    "--env",
    "--read-only=false",
  ];
  const result = fixture.run(["run", "--", ...child, ...expected]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    JSON.parse(readFileSync(join(fixture.cwd, "child-result.json"), "utf8")),
    expected,
  );
});

for (const flag of globals) {
  for (const toolFlag of ["--help", "--version"]) {
    for (const separator of [[], ["--"]]) {
      it(`${flag}=true before guard-observe cannot capture tool ${toolFlag} with separator ${separator.length > 0}`, (t) => {
        const fixture = createCliContractFixture();
        t.after(() => fixture.cleanup());
        fixture.env.KIT_GUARD_DIR = join(fixture.root, "shims");
        fixture.env.KIT_GUARD_LOG = join(fixture.root, "observations.jsonl");
        const before = fixture.snapshot();
        const result = fixture.run([
          `${flag}=true`,
          "guard-observe",
          ...separator,
          "node",
          toolFlag,
        ]);
        assert.equal(result.status, 2, result.stdout + result.stderr);
        assert.match(result.stderr, new RegExp(`${flag} does not accept a value`));
        assert.equal(result.stdout, "");
        assert.deepEqual(fixture.snapshot(), before);
      });
    }
  }
}
