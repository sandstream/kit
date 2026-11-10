import assert from "node:assert/strict";
import { it } from "node:test";
import { createCliContractFixture } from "./cli-contract.test-support.js";

const rootCredential = `ghp_${"a".repeat(36)}`;
const browserCredential = `ghp_${"b".repeat(36)}`;
const rootKey = `root\x1b[2J\nspoof\u202e ${rootCredential}`;
const browserKey = `browser\x1b]52;c;opaque\x07\nspoof\u2028 ${browserCredential}`;
const config = `version = 1
[browser]
port = 3000
${JSON.stringify(browserKey)} = "future-browser-value"
[${JSON.stringify(rootKey)}]
future = "future-root-value"
`;

for (const [args, rootWarnings] of [
  [["completions", "bash"], 1],
  [["governance"], 2],
] as const) {
  it(`${args[0]} sanitizes configuration warnings without changing their frequency or files`, (t) => {
    const fixture = createCliContractFixture(config);
    t.after(() => fixture.cleanup());
    const before = fixture.snapshot();
    const result = fixture.run([...args]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(result.stdout.length > 0);
    assert.ok(!result.stderr.includes(rootCredential), result.stderr);
    assert.ok(!result.stderr.includes(browserCredential), result.stderr);
    assert.doesNotMatch(
      result.stderr,
      /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\u202e]/,
    );
    const warnings = result.stderr.split("\n").filter((line) => line.startsWith("Warning:"));
    assert.equal(warnings.length, rootWarnings + 1, result.stderr);
    assert.equal(
      warnings.filter((line) => line.startsWith("Warning: unknown section [rootspoof [REDACTED]]"))
        .length,
      rootWarnings,
    );
    assert.equal(
      warnings.filter((line) =>
        line.startsWith("Warning: unknown key [browser].browserspoof [REDACTED]"),
      ).length,
      1,
    );
    assert.doesNotMatch(result.stderr, /future-browser-value|future-root-value|opaque/);
    assert.deepEqual(fixture.snapshot(), before);
  });
}
