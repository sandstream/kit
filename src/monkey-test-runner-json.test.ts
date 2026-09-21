import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { it } from "node:test";
import type { MonkeyRunResult } from "./monkey-test-contract.js";
import { fixtureCommand, runnerFixture, serverCommand } from "./monkey-test-runner.test-support.js";
import { noisyCommand, OUTPUT_SECRET } from "./monkey-test-runner-report.test-support.js";
import { runMonkey } from "./monkey-test-runner-subprocess.test-support.js";

for (const outcome of ["pass", "test failure", "seed failure", "browser skipped"]) {
  it(`MSG-04: --json stays parseable with noisy child output (${outcome})`, async () => {
    const root = await runnerFixture();
    try {
      const result = await runMonkey(root, [
        "--json",
        "--env-command",
        fixtureCommand(
          root,
          "env",
          `process.stdout.write(JSON.stringify({MONKEY_TEST_SECRET: ${JSON.stringify(OUTPUT_SECRET)}}));`,
        ),
        "--seed-command",
        noisyCommand(root, "seed", outcome === "seed failure" ? 7 : 0),
        "--start-command",
        serverCommand(root),
        "--test-command",
        noisyCommand(root, "test", outcome === "test failure" ? 9 : 0),
        ...(outcome === "browser skipped" ? ["--skip-browser"] : []),
      ]);
      assert.equal(result.code, outcome === "pass" ? 0 : 1, result.stderr);
      assert.ok(
        !`${result.stdout}${result.stderr}`.includes(OUTPUT_SECRET),
        "secret leaked across output chunks",
      );
      const report = JSON.parse(result.stdout) as MonkeyRunResult;
      assert.equal(report.ok, outcome === "pass");
      assert.match(result.stderr, /seed stdout/);
      assert.match(result.stderr, /seed stderr/);
      assert.match(result.stderr, /seed partial \[REDACTED\]/);
      if (outcome === "pass" || outcome === "test failure") {
        assert.match(result.stderr, /test stdout/);
        assert.match(result.stderr, /test stderr/);
        assert.match(result.stderr, /test partial \[REDACTED\]/);
      }
      if (outcome === "test failure")
        assert.ok(
          report.findings.some((finding) => finding.title === "Playwright monkey crawl failed"),
        );
      if (outcome === "seed failure")
        assert.ok(report.findings.some((finding) => finding.title === "Seed command failed"));
      if (outcome === "browser skipped")
        assert.ok(report.findings.some((finding) => finding.title === "Browser evidence skipped"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
