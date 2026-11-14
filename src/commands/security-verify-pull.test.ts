import { it } from "node:test";
import assert from "node:assert/strict";
import { repo, write, commit, runNode } from "../post-pull-audit.test-support.js";

function invokeCommand(dir: string, args: string[]): { status: number | null; output: string } {
  const moduleUrl = new URL("./security-verify-pull.js", import.meta.url).href;
  const script = [
    `const { cmdSecurityVerifyPull } = await import(${JSON.stringify(moduleUrl)});`,
    `process.argv = [process.execPath, "kit", "security", "verify-pull", ...${JSON.stringify(args)}];`,
    "process.exitCode = await cmdSecurityVerifyPull() ? 0 : 1;",
  ].join("\n");
  return runNode(dir, ["--input-type=module", "--eval", script]);
}

it("the verify-pull command module returns success for an inspected unchanged range", (t) => {
  const dir = repo(t);
  commit(dir);
  const result = invokeCommand(dir, ["--base", "HEAD~1", "--json"]);
  assert.equal(result.status, 0);
  const report = JSON.parse(result.output);
  assert.equal(report.severity, "ok");
  assert.equal(report.coverage.status, "complete");
  assert.deepEqual(report.errors, []);
});

it("the verify-pull command module returns success with dependency review warnings", (t) => {
  const dir = repo(t);
  write(dir, "package.json", '{"dependencies":{"example":"2.0.0"}}');
  commit(dir);
  const result = invokeCommand(dir, ["--base", "HEAD~1", "--json"]);
  assert.equal(result.status, 0);
  const report = JSON.parse(result.output);
  assert.equal(report.severity, "warn");
  assert.equal(report.coverage.status, "complete");
  assert.deepEqual(report.dependencyChanges, [
    {
      file: "package.json",
      section: "dependencies",
      name: "example",
      kind: "changed",
      before: "1.0.0",
      after: "2.0.0",
    },
  ]);
});

it("the verify-pull command module returns failure for an uninspectable range", (t) => {
  const dir = repo(t);
  const result = invokeCommand(dir, ["--base", "missing", "--json"]);
  assert.equal(result.status, 1);
  const report = JSON.parse(result.output);
  assert.equal(report.severity, "fail");
  assert.equal(report.coverage.status, "incomplete");
  assert.ok(report.errors.some((error: { code: string }) => error.code === "ref-unavailable"));
});
