import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import type { MonkeyRunResult } from "./monkey-test-contract.js";
import { markerCommand, runnerFixture, serverCommand } from "./monkey-test-runner.test-support.js";
import { runMonkey } from "./monkey-test-runner-subprocess.test-support.js";

for (const missing of ["dependency", "harness"] as const) {
  it(`MSG-02: missing ${missing} prevents commands before side effects`, async () => {
    const root = await runnerFixture();
    try {
      if (missing === "dependency") writeFileSync(join(root, "package.json"), "{}");
      else rmSync(join(root, "tests/monkey/monkey.spec.ts"));
      const result = await runMonkey(root, [
        "--json",
        "--env-command",
        markerCommand(root, "env"),
        "--seed-command",
        markerCommand(root, "seed"),
        "--start-command",
        serverCommand(root),
        "--test-command",
        markerCommand(root, "test"),
      ]);
      assert.equal(result.code, 1, result.stderr);
      const report = JSON.parse(result.stdout) as MonkeyRunResult;
      assert.equal(report.ok, false);
      const title =
        missing === "dependency" ? "Playwright dependency missing" : "Monkey harness incomplete";
      assert.ok(report.findings.some((finding) => finding.title === title));
      for (const stage of ["env", "seed", "server", "test"]) {
        assert.equal(
          existsSync(join(root, `${stage}.ran`)),
          false,
          `${stage} ran despite missing ${missing}`,
        );
      }
      assert.ok(report.steps.some((step) => step.name === "seed" && step.status === "skip"));
      assert.ok(report.steps.some((step) => step.name === "browser" && step.status === "skip"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
