import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import type { MonkeyRunResult, MonkeyTestPlan } from "./monkey-test-contract.js";
import { runnerFixture } from "./monkey-test-runner.test-support.js";
import {
  assertRefused,
  assertInvalidEnvironment,
  providerCommand,
  runEnvironmentCli,
  runPublicEnvironment,
  sentinelOptions,
  syntheticLiveKey,
  unsupportedDotenvInputs,
} from "./monkey-test-runner-env.test-support.js";

it("MSG-06: inherited references cannot override a literal sandbox file through loader expansion", async () => {
  const root = await runnerFixture();
  try {
    writeFileSync(join(root, ".env"), "API_TOKEN=sk_test_literal\n");
    const env = {
      API_TOKEN: "${PREFIX}_${MODE}_syntheticOnly123456789",
      PREFIX: "sk",
      MODE: "live",
    };
    const planned = await runEnvironmentCli(root, ["plan", "--json"], env);
    const plan = JSON.parse(planned.stdout) as MonkeyTestPlan;
    assert.equal(plan.money.sandboxOnly, false);
    assert.ok(plan.checks.some((check) => check.name === "env" && check.status === "fail"));
    const result = await runPublicEnvironment(
      root,
      {
        ...sentinelOptions(root),
        envCommand: providerCommand(root, "SAFE=yes\n"),
      },
      env,
    );
    assertInvalidEnvironment(root, result, "Application environment could not be inspected");
    assert.ok(
      !`${planned.stdout}${planned.stderr}${result.stdout}${result.stderr}`.includes(env.API_TOKEN),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const [syntax, output] of Object.entries({
  ...unsupportedDotenvInputs,
  "JSON reference": JSON.stringify({ MODE: "live", MONKEY_PAYMENT_MODE: "${MODE}" }),
  "JSON command substitution": JSON.stringify({ MONKEY_PAYMENT_MODE: "$(printf live)" }),
})) {
  it(`MSG-05: provider ${syntax} is rejected before seed/server/test`, async () => {
    const root = await runnerFixture();
    try {
      const result = await runPublicEnvironment(root, {
        ...sentinelOptions(root),
        envCommand: providerCommand(root, output),
      });
      const report = assertInvalidEnvironment(root, result, "Temporary env output invalid", [
        "seed",
        "server",
        "test",
      ]);
      assert.ok(report.steps.some((step) => step.name === "env" && step.status === "fail"));
      assert.equal(existsSync(join(root, "env.ran")), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const format of ["json", "dotenv"]) {
  it(`MSG-05: CLI rejects ${format} NUL values without leaking spawn errors`, async () => {
    const root = await runnerFixture();
    try {
      const secret = "syntheticInvalidProviderSecret123456789";
      const value = `${secret}\0tail`;
      const output =
        format === "json" ? JSON.stringify({ API_TOKEN: value }) : `export API_TOKEN="${value}"\n`;
      const options = sentinelOptions(root);
      const result = await runEnvironmentCli(root, [
        "run",
        "--json",
        "--skip-security",
        "--expected",
        options.expectedReason!,
        "--env-command",
        providerCommand(root, output),
        "--seed-command",
        options.seedCommand!,
        "--start-command",
        options.startCommand!,
        "--test-command",
        options.testCommand!,
      ]);
      assert.equal(result.code, 1);
      assert.ok(!`${result.stdout}${result.stderr}`.includes(secret), "provider value leaked");
      const report = JSON.parse(result.stdout) as MonkeyRunResult;
      assert.ok(
        report.findings.some((finding) => finding.title === "Temporary env output invalid"),
      );
      assert.ok(report.steps.some((step) => step.name === "env" && step.status === "fail"));
      assert.equal(existsSync(join(root, "env.ran")), true);
      for (const stage of ["seed", "server", "test"])
        assert.equal(existsSync(join(root, `${stage}.ran`)), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const prefix of ["sk", "pk", "rk"]) {
  it(`MSG-06: ${prefix} live value is refused under an arbitrary name in process env`, async () => {
    const root = await runnerFixture();
    try {
      const value = syntheticLiveKey.replace(/^sk/, prefix);
      const result = await runPublicEnvironment(
        root,
        {
          ...sentinelOptions(root),
          skipBrowser: true,
          skipSeed: true,
        },
        { CHECKOUT_KEY: ` \t${value}\n` },
      );
      const report = assertRefused(root, result);
      assert.ok(!`${result.stdout}${result.stderr}`.includes(value));
      assert.ok(report.findings.some((finding) => finding.title === "Browser evidence skipped"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

it("MSG-06: live output is checked before reserved runner fields are discarded", async () => {
  const root = await runnerFixture();
  try {
    const result = await runPublicEnvironment(root, {
      ...sentinelOptions(root),
      envCommand: providerCommand(root, `export PORT=${syntheticLiveKey}\n`),
    });
    assertRefused(root, result);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const source of ["process", "provider"]) {
  it(`MSG-06: ${source} live payment mode cannot be waived by explicit skip reasons`, async () => {
    const root = await runnerFixture();
    try {
      const env = { MONKEY_PAYMENT_MODE: "  LiVe \n" };
      const options = { ...sentinelOptions(root), skipBrowser: true, skipSeed: true };
      const result =
        source === "process"
          ? await runPublicEnvironment(root, options, env)
          : await runPublicEnvironment(root, {
              ...options,
              envCommand: providerCommand(root, JSON.stringify(env)),
            });
      assertRefused(root, result);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const failure of ["exit", "json syntax", "json array"]) {
  it(`MSG-05: provider ${failure} fails closed without leaking stdout, stderr or parser errors`, async () => {
    const root = await runnerFixture();
    try {
      const output =
        failure === "json syntax"
          ? `{"KEY":"${syntheticLiveKey}"`
          : JSON.stringify([syntheticLiveKey]);
      const extra =
        failure === "exit"
          ? 'process.stderr.write(readFileSync("provider-output", "utf8")); process.exitCode = 7;'
          : "";
      const result = await runPublicEnvironment(root, {
        ...sentinelOptions(root),
        envCommand: providerCommand(root, output, extra),
      });
      const report = JSON.parse(result.stdout) as MonkeyRunResult;
      const title =
        failure === "exit" ? "Temporary env command failed" : "Temporary env output invalid";
      assert.equal(result.code, 1);
      assert.ok(report.findings.some((finding) => finding.title === title));
      assert.ok(report.steps.some((step) => step.name === "env" && step.status === "fail"));
      for (const stage of ["seed", "server", "test"])
        assert.equal(existsSync(join(root, `${stage}.ran`)), false);
      assert.ok(!`${result.stdout}${result.stderr}`.includes(syntheticLiveKey));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
