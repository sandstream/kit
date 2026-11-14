import { it } from "node:test";
import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { repo, write, commit, cli } from "./post-pull-audit.test-support.js";

it("never substitutes a default for an explicitly empty or missing ref value", (t) => {
  const dir = repo(t);
  commit(dir);
  for (const refArgs of [["--base="], ["--base", ""], ["--base"], ["--head="], ["--head"]]) {
    for (const format of [[], ["--json"]]) {
      const result = cli(dir, ...format, ...refArgs);
      assert.equal(result.status, 1, result.output);
      if (format.length > 0) {
        const report = JSON.parse(result.output);
        assert.equal(report.coverage.status, "incomplete");
        assert.ok(
          report.errors.some((error: { code: string }) => error.code === "ref-unavailable"),
        );
      }
    }
  }
});

it("fails in text and JSON modes for invalid refs and deletion-only security regressions", (t) => {
  const dir = repo(t);
  write(dir, ".gitignore", ".env\n");
  commit(dir);
  unlinkSync(join(dir, ".gitignore"));
  commit(dir);
  for (const args of [
    ["--base", "missing"],
    ["--base", "HEAD~1"],
  ]) {
    const text = cli(dir, ...args);
    assert.equal(text.status, 1, text.output);
    assert.doesNotMatch(text.output, /Nothing to audit|No security concerns/);
    const json = cli(dir, ...args, "--json");
    assert.equal(json.status, 1, json.output);
    const report = JSON.parse(json.output);
    assert.equal(report.severity, "fail");
    assert.equal(report.coverage.status, args[1] === "missing" ? "incomplete" : "complete");
  }
});

it("shows changed specifications and masks credentials in text and JSON diagnostics", (t) => {
  const dir = repo(t);
  const token = "ghp_" + "c".repeat(36);
  write(dir, "nested/package.json", '{"devDependencies":{"example":"1.0.0"}}');
  commit(dir);
  write(dir, "nested/package.json", '{"devDependencies":{"example":"npm:replacement@2.0.0"}}');
  commit(dir);
  const text = cli(dir, "--base", "HEAD~1");
  assert.equal(text.status, 0, text.output);
  assert.match(text.output, /nested\/package\.json/);
  assert.match(text.output, /devDependencies/);
  assert.match(text.output, /1\.0\.0/);
  assert.match(text.output, /npm:replacement@2\.0\.0/);
  for (const format of [[], ["--json"]]) {
    const invalid = cli(dir, "--base", token, ...format);
    assert.equal(invalid.status, 1);
    assert.ok(!invalid.output.includes(token));
    assert.match(invalid.output, /\[REDACTED\]/);
    write(dir, "package.json", `{"password":"${token}`);
    commit(dir);
    const malformed = cli(dir, "--base", "HEAD~1", ...format);
    assert.equal(malformed.status, 1);
    assert.ok(!malformed.output.includes(token));
    assert.match(malformed.output, /invalid-manifest/);
  }
});
