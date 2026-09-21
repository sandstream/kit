import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const matrixPath = ".kit/monkey-test/role-matrix.json";
const invalidMatrix = JSON.stringify({ configured: true, roles: [] });

for (const kind of ["malformed", "invalid"]) {
  for (const skipBrowser of [false, true]) {
    it(`MSG-02: ${kind} role matrix ${skipBrowser ? "preserves explicit browser-skip seed execution" : "stops seed and browser side effects"}`, async () => {
      const root = await runnerFixture();
      try {
        writeFileSync(join(root, matrixPath), kind === "malformed" ? "{" : invalidMatrix);
        const result = await runMonkey(root, [
          "--json",
          "--seed-command",
          markerCommand(root, "seed"),
          "--start-command",
          serverCommand(root),
          "--test-command",
          markerCommand(root, "test"),
          ...(skipBrowser ? ["--skip-browser"] : []),
        ]);
        assert.equal(result.code, 1, result.stderr);
        const report = JSON.parse(result.stdout) as MonkeyRunResult;
        assert.equal(report.ok, false);
        assert.ok(
          report.findings.some(
            (finding) =>
              finding.title === "Monkey role matrix invalid" && finding.severity === "critical",
          ),
        );
        assert.equal(
          existsSync(join(root, "seed.ran")),
          skipBrowser,
          "seed execution ignored role prerequisite or explicit browser skip",
        );
        assert.equal(existsSync(join(root, "server.ran")), false);
        assert.equal(existsSync(join(root, "test.ran")), false);
        assert.deepEqual(
          report.steps.filter((step) => step.name === "seed").map((step) => step.status),
          [skipBrowser ? "pass" : "skip"],
        );
        assert.deepEqual(
          report.steps.filter((step) => step.name === "browser").map((step) => step.status),
          ["skip"],
        );
        if (skipBrowser)
          assert.ok(
            report.findings.some((finding) => finding.title === "Browser evidence skipped"),
          );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}

function roleEnvCommand(root: string): string {
  return fixtureCommand(
    root,
    "env",
    `import { writeFileSync } from "node:fs";
writeFileSync("env.ran", "yes");
process.stdout.write(JSON.stringify({ MONKEY_ROLE_MATRIX: "selected-roles.json" }));`,
  );
}

for (const selectedValid of [false, true]) {
  it(`MSG-02: env-selected ${selectedValid ? "valid" : "invalid"} matrix controls seed eligibility`, async () => {
    const root = await runnerFixture();
    try {
      const validMatrix = readFileSync(join(root, matrixPath), "utf8");
      writeFileSync(join(root, "selected-roles.json"), selectedValid ? validMatrix : invalidMatrix);
      if (selectedValid) writeFileSync(join(root, matrixPath), "{");
      const result = await runMonkey(root, [
        "--json",
        "--env-command",
        roleEnvCommand(root),
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
      assert.equal(existsSync(join(root, "env.ran")), true);
      assert.ok(report.steps.some((step) => step.name === "env" && step.status === "pass"));
      const finding = report.findings.find((item) => item.title === "Monkey role matrix invalid");
      if (selectedValid) {
        assert.equal(finding, undefined);
        assert.ok(
          report.findings.some((item) => item.title === "Playwright evidence missing or invalid"),
        );
      } else {
        assert.equal(finding?.severity, "critical");
        assert.equal(finding?.file, "selected-roles.json");
      }
      for (const stage of ["seed", "server", "test"]) {
        assert.equal(
          existsSync(join(root, `${stage}.ran`)),
          selectedValid,
          `${stage} ignored env-selected matrix`,
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
