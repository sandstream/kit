import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import type { MonkeyRunResult, MonkeyTestPlan } from "./monkey-test-contract.js";
import { fixtureCommand, runnerFixture } from "./monkey-test-runner.test-support.js";
import {
  assertRefused,
  providerCommand,
  runEnvironmentCli,
  runPublicEnvironment,
  sentinelOptions,
  syntheticLiveKey,
  syntheticTestKey,
} from "./monkey-test-runner-env.test-support.js";

it("MSG-05: exported dotenv reaches a real seed without writing env files or changing caller env", async () => {
  const root = await runnerFixture();
  try {
    const result = await runPublicEnvironment(root, {
      ...sentinelOptions(root),
      skipBrowser: true,
      envCommand: providerCommand(
        root,
        `export CHECKOUT_KEY="${syntheticTestKey}"\nexport LABEL='seed # label'\n`,
      ),
      seedCommand: fixtureCommand(
        root,
        "seed",
        `import { writeFileSync } from "node:fs";
const valid = process.env.CHECKOUT_KEY?.startsWith(["sk", "test", ""].join("_")) && process.env.LABEL === "seed # label";
writeFileSync("seed.ran", valid ? "loaded" : "missing");`,
      ),
    });
    const report = JSON.parse(result.stdout) as MonkeyRunResult;
    assert.equal(readFileSync(join(root, "seed.ran"), "utf8"), "loaded");
    assert.ok(report.steps.some((step) => step.name === "env" && step.status === "pass"));
    assert.ok(report.findings.some((finding) => finding.title === "Browser evidence skipped"));
    for (const file of [".env", ".env.local"]) assert.equal(existsSync(join(root, file)), false);
    assert.ok(!`${result.stdout}${result.stderr}`.includes(syntheticTestKey));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const dialect of ["export", "arbitrary name", "whitespace", "json whitespace"]) {
  it(`MSG-05/06 MHB-07-r1: refuses provider ${dialect} before seed/server/tests`, async () => {
    const root = await runnerFixture();
    try {
      const outputs: Record<string, string> = {
        export: `export STRIPE_SECRET_KEY=${syntheticLiveKey}\n`,
        "arbitrary name": `CHECKOUT_KEY=${syntheticLiveKey}\n`,
        whitespace: `STRIPE_SECRET_KEY="  ${syntheticLiveKey}  "\n`,
        "json whitespace": JSON.stringify({ CHECKOUT_KEY: ` \t${syntheticLiveKey}\n` }),
      };
      const result = await runPublicEnvironment(root, {
        ...sentinelOptions(root),
        envCommand: providerCommand(root, outputs[dialect]),
      });
      assertRefused(root, result);
      assert.equal(existsSync(join(root, "env.ran")), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

it("MSG-06: inherited live value blocks even the provider and cannot be replaced by sandbox output", async () => {
  const root = await runnerFixture();
  try {
    const result = await runPublicEnvironment(
      root,
      {
        ...sentinelOptions(root),
        envCommand: providerCommand(root, JSON.stringify({ CHECKOUT_KEY: syntheticTestKey })),
      },
      { CHECKOUT_KEY: `  ${syntheticLiveKey}  ` },
    );
    assertRefused(root, result, ["env", "seed", "server", "test"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("MSG-07: actual CLI plan reports app-autoloaded .env.local without revealing values", async () => {
  const root = await runnerFixture();
  try {
    writeFileSync(join(root, ".env.local"), `export CHECKOUT_KEY=" ${syntheticLiveKey} "\n`);
    const result = await runEnvironmentCli(root, ["plan", "--json"]);
    const plan = JSON.parse(result.stdout) as MonkeyTestPlan;
    assert.equal(plan.money.sandboxOnly, false, "plan missed app-autoloaded live key");
    assert.ok(plan.findings.some((finding) => finding.file === ".env.local"));
    assert.ok(plan.checks.some((check) => check.name === "env" && check.status === "fail"));
    assert.ok(!`${result.stdout}${result.stderr}`.includes(syntheticLiveKey));
    assert.equal(result.code, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("MSG-07: actual CLI refuses .env.local before provider even with explicit security/browser skips", async () => {
  const root = await runnerFixture();
  try {
    const content = `CHECKOUT_KEY=${syntheticLiveKey}\n`;
    writeFileSync(join(root, ".env.local"), content);
    const options = sentinelOptions(root);
    const result = await runEnvironmentCli(root, [
      "run",
      "--json",
      "--skip-security",
      "--skip-browser",
      "--expected",
      options.expectedReason!,
      "--env-command",
      providerCommand(root, "SAFE=value\n"),
      "--seed-command",
      options.seedCommand!,
      "--start-command",
      options.startCommand!,
      "--test-command",
      options.testCommand!,
    ]);
    assertRefused(root, result, ["env", "seed", "server", "test"]);
    assert.equal(readFileSync(join(root, ".env.local"), "utf8"), content);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
