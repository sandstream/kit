import { it } from "node:test";
import assert from "node:assert/strict";
import { auditPull, reportSeverity } from "./post-pull-audit.js";
import { repo, write, commit, cli } from "./post-pull-audit.test-support.js";

for (const mode of ["api", "text", "json"] as const) {
  for (const sensitive of [true, false]) {
    it(`classifies ignore removals before redaction (${sensitive ? "sensitive" : "benign"}, ${mode})`, async (t) => {
      const dir = repo(t);
      const secret = "abcdefghijklmnopqrst";
      const removed = `password=${secret}/${sensitive ? ".env" : "cache"}`;
      write(dir, ".gitignore", `${removed}\nnode_modules\n`);
      commit(dir);
      write(dir, ".gitignore", "node_modules\n");
      commit(dir);
      if (mode === "api") {
        const report = await auditPull(dir);
        assert.equal(reportSeverity(report), sensitive ? "fail" : "ok");
        assert.equal(report.coverage.status, "complete");
        assert.ok(!JSON.stringify(report).includes(secret));
        assert.deepEqual(report.gitignoreRemovals, [{ entry: "password=[REDACTED]", sensitive }]);
        assert.equal(reportSeverity(JSON.parse(JSON.stringify(report))), sensitive ? "fail" : "ok");
      } else {
        const result = cli(dir, "--base", "HEAD~1", ...(mode === "json" ? ["--json"] : []));
        assert.equal(result.status, sensitive ? 1 : 0);
        assert.ok(!result.output.includes(secret));
        assert.match(result.output, /\[REDACTED\]/);
        if (mode === "json") {
          const report = JSON.parse(result.output);
          assert.equal(report.severity, sensitive ? "fail" : "ok");
          assert.deepEqual(report.gitignoreRemovals, [{ entry: "password=[REDACTED]", sensitive }]);
        } else {
          assert.match(result.output, sensitive ? /\[sensitive\]/ : /\[low\]/);
          if (sensitive) assert.doesNotMatch(result.output, /No findings/);
        }
      }
    });
  }

  it(`preserves different risks when removed entries have identical redacted text (${mode})`, async (t) => {
    const dir = repo(t);
    const secret = "abcdefghijklmnopqrst";
    write(dir, ".gitignore", `password=${secret}/.env\npassword=${secret}/cache\nnode_modules\n`);
    commit(dir);
    write(dir, ".gitignore", "node_modules\n");
    commit(dir);
    const expected = [
      { entry: "password=[REDACTED]", sensitive: true },
      { entry: "password=[REDACTED]", sensitive: false },
    ];
    if (mode === "api") {
      const report = await auditPull(dir);
      assert.equal(reportSeverity(report), "fail");
      assert.deepEqual(report.gitignoreRemovals, expected);
      assert.ok(!JSON.stringify(report).includes(secret));
    } else {
      const result = cli(dir, "--base", "HEAD~1", ...(mode === "json" ? ["--json"] : []));
      assert.equal(result.status, 1);
      assert.ok(!result.output.includes(secret));
      if (mode === "json") {
        assert.deepEqual(JSON.parse(result.output).gitignoreRemovals, expected);
      } else {
        assert.equal(result.output.match(/\[sensitive\]/g)?.length, 1);
        assert.equal(result.output.match(/\[low\]/g)?.length, 1);
      }
    }
  });
}
