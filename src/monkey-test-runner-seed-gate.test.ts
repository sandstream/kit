import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import type { MonkeyRunResult } from "./monkey-test-contract.js";
import {
  fixtureCommand,
  markerCommand,
  runnerFixture,
  serverCommand,
} from "./monkey-test-runner.test-support.js";
import { runMonkey } from "./monkey-test-runner-subprocess.test-support.js";

function failedSeedCommand(root: string): string {
  return fixtureCommand(
    root,
    "seed",
    `import { writeFileSync } from "node:fs";
writeFileSync("seed.ran", "yes");
process.exitCode = 7;`,
  );
}

it("MSG-02: failed seed prevents dev-server and test-command side effects", async () => {
  const root = await runnerFixture();
  try {
    const result = await runMonkey(root, [
      "--json",
      "--seed-command",
      failedSeedCommand(root),
      "--start-command",
      serverCommand(root),
      "--test-command",
      markerCommand(root, "test"),
    ]);
    assert.equal(result.code, 1, result.stderr);
    const report = JSON.parse(result.stdout) as MonkeyRunResult;
    assert.equal(report.ok, false);
    assert.equal(existsSync(join(root, "seed.ran")), true, "seed command was not exercised");
    assert.ok(
      report.findings.some(
        (finding) => finding.title === "Seed command failed" && finding.severity === "critical",
      ),
    );
    assert.deepEqual(
      report.steps.filter((step) => step.name === "seed").map((step) => step.status),
      ["fail"],
    );
    assert.equal(
      existsSync(join(root, "server.ran")),
      false,
      "dev server started after failed seed",
    );
    assert.equal(existsSync(join(root, "test.ran")), false, "test command ran after failed seed");
    assert.equal(report.baseUrl, undefined);
    assert.equal(report.port, undefined);
    assert.ok(
      report.steps.some(
        (step) => step.name === "browser" && step.status === "skip" && /seed/.test(step.detail),
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

it("MSG-02: justified --skip-seed still starts browser execution", async () => {
  const root = await runnerFixture();
  try {
    const result = await runMonkey(root, [
      "--json",
      "--skip-seed",
      "--seed-command",
      failedSeedCommand(root),
      "--start-command",
      serverCommand(root),
      "--test-command",
      markerCommand(root, "test"),
    ]);
    assert.equal(result.code, 1, result.stderr);
    const report = JSON.parse(result.stdout) as MonkeyRunResult;
    assert.equal(existsSync(join(root, "seed.ran")), false);
    assert.deepEqual(
      report.steps.filter((step) => step.name === "seed").map((step) => step.status),
      ["skip"],
    );
    assert.equal(existsSync(join(root, "server.ran")), true);
    assert.equal(existsSync(join(root, "test.ran")), true);
    assert.equal(report.ok, false);
    assert.ok(
      report.findings.some((finding) => finding.title === "Playwright evidence missing or invalid"),
    );
    assert.ok(!report.findings.some((finding) => finding.title === "Seed command failed"));
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
