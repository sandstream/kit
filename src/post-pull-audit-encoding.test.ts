import { it } from "node:test";
import assert from "node:assert/strict";
import { auditPull, reportSeverity } from "./post-pull-audit.js";
import { repo, manifestTreeRange, write, commit, cli } from "./post-pull-audit.test-support.js";

for (const mode of ["api", "text", "json"] as const) {
  it(`rejects non-UTF-8 tree paths before byte-distinct manifests can collide (${mode})`, async (t) => {
    const dir = repo(t);
    const { base, head } = manifestTreeRange(dir, [Buffer.from([0xfe]), Buffer.from([0xff])], "{");
    if (mode === "api") {
      const report = await auditPull(dir, base, head);
      assert.equal(reportSeverity(report), "fail");
      assert.equal(report.coverage.status, "incomplete");
      assert.equal(report.coverage.fileScope, "unknown");
      assert.ok(report.errors.some((error) => error.code === "invalid-path-encoding"));
    } else {
      const result = cli(
        dir,
        "--base",
        base,
        "--head",
        head,
        ...(mode === "json" ? ["--json"] : []),
      );
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /invalid-path-encoding/);
      assert.ok(!result.output.includes("\uFFFD"));
      if (mode === "json") {
        const report = JSON.parse(result.output);
        assert.equal(report.severity, "fail");
        assert.equal(report.coverage.status, "incomplete");
        assert.equal(report.coverage.fileScope, "unknown");
      }
    }
  });

  it(`keeps valid UTF-8 tree paths distinct, including a literal replacement character (${mode})`, async (t) => {
    const dir = repo(t);
    const { base, head } = manifestTreeRange(
      dir,
      [Buffer.from("\u00e5"), Buffer.from("\uFFFD")],
      '{"dependencies":{"example":"2.0.0"}}',
    );
    if (mode === "api") {
      const report = await auditPull(dir, base, head);
      assert.equal(reportSeverity(report), "warn");
      assert.equal(report.coverage.status, "complete");
      assert.deepEqual(report.coverage.manifestFiles, ["\u00e5/package.json", "\uFFFD/package.json"]);
      assert.deepEqual(
        report.dependencyChanges.map((change) => [change.file, change.before, change.after]),
        [["\u00e5/package.json", "1.0.0", "2.0.0"]],
      );
    } else {
      const result = cli(
        dir,
        "--base",
        base,
        "--head",
        head,
        ...(mode === "json" ? ["--json"] : []),
      );
      assert.equal(result.status, 0, result.output);
      assert.match(result.output, /\u00e5\/package\.json/);
      if (mode === "json") {
        const report = JSON.parse(result.output);
        assert.equal(report.severity, "warn");
        assert.equal(report.coverage.status, "complete");
      }
    }
  });

  for (const version of ["1.0.0", "2.0.0"]) {
    it(`accepts a UTF-8 BOM in root and nested manifests (${version === "1.0.0" ? "unchanged" : "changed"}, ${mode})`, async (t) => {
      const dir = repo(t);
      const paths = ["nested/package.json", "package.json"];
      for (const file of paths) {
        write(dir, file, '\uFEFF{"dependencies":{"example":"1.0.0"}}');
      }
      commit(dir);
      for (const file of paths) {
        write(
          dir,
          file,
          `\uFEFF{"description":"metadata edit","dependencies":{"example":"${version}"}}`,
        );
      }
      commit(dir);
      const severity = version === "1.0.0" ? "ok" : "warn";
      if (mode === "api") {
        const report = await auditPull(dir);
        assert.equal(reportSeverity(report), severity);
        assert.equal(report.coverage.status, "complete");
        assert.deepEqual(report.errors, []);
        assert.deepEqual(
          report.dependencyChanges.map((change) => [change.file, change.before, change.after]),
          version === "1.0.0"
            ? []
            : [
                ["nested/package.json", "1.0.0", "2.0.0"],
                ["package.json", "1.0.0", "2.0.0"],
              ],
        );
      } else {
        const result = cli(dir, "--base", "HEAD~1", ...(mode === "json" ? ["--json"] : []));
        assert.equal(result.status, 0, result.output);
        assert.doesNotMatch(result.output, /invalid-manifest/);
        if (mode === "json") {
          const report = JSON.parse(result.output);
          assert.equal(report.severity, severity);
          assert.equal(report.coverage.status, "complete");
          assert.deepEqual(report.errors, []);
        } else if (version === "1.0.0") {
          assert.match(result.output, /No findings within the reported inspection scope/);
        } else {
          assert.match(result.output, /nested\/package\.json/);
          assert.match(result.output, /2\.0\.0/);
        }
      }
    });
  }

  it(`still rejects malformed JSON after a UTF-8 BOM (${mode})`, async (t) => {
    const dir = repo(t);
    write(dir, "package.json", "\uFEFF{");
    commit(dir);
    if (mode === "api") {
      const report = await auditPull(dir);
      assert.equal(reportSeverity(report), "fail");
      assert.equal(report.coverage.status, "incomplete");
      assert.ok(report.errors.some((error) => error.code === "invalid-manifest"));
    } else {
      const result = cli(dir, "--base", "HEAD~1", ...(mode === "json" ? ["--json"] : []));
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /invalid-manifest/);
      if (mode === "json") assert.equal(JSON.parse(result.output).coverage.status, "incomplete");
    }
  });
}
