import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import type { MonkeyRunResult, MonkeyTestPlan } from "./monkey-test-contract.js";
import { fixtureCommand, runnerFixture } from "./monkey-test-runner.test-support.js";
import { eventually, processRunning } from "./monkey-test-runner-subprocess.test-support.js";
import {
  assertRefused,
  assertInvalidEnvironment,
  providerCommand,
  runEnvironmentCli,
  runPublicEnvironment,
  sentinelOptions,
  syntheticLiveKey,
  syntheticTestKey,
  unsupportedDotenvInputs,
} from "./monkey-test-runner-env.test-support.js";

it("MSG-07: empty assignments cannot conceal later live values", async () => {
  const root = await runnerFixture();
  try {
    writeFileSync(join(root, ".env"), `EMPTY=  \nCHECKOUT_KEY=${syntheticLiveKey}\n`);
    const result = await runPublicEnvironment(root, {
      ...sentinelOptions(root),
      envCommand: providerCommand(root, "SAFE=yes\n"),
    });
    assertRefused(root, result, ["env", "seed", "server", "test"]);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

for (const [syntax, content] of Object.entries(unsupportedDotenvInputs)) {
  it(`MSG-07: root ${syntax} fails closed in CLI plan and before provider`, async () => {
    const root = await runnerFixture();
    try {
      writeFileSync(join(root, ".env.local"), content);
      const planned = await runEnvironmentCli(root, ["plan", "--json"]);
      const plan = JSON.parse(planned.stdout) as MonkeyTestPlan;
      assert.equal(planned.code, 1);
      assert.equal(plan.money.sandboxOnly, false);
      assert.ok(plan.checks.some((check) => check.name === "env" && check.status === "fail"));
      assert.ok(!`${planned.stdout}${planned.stderr}`.includes(syntheticLiveKey));
      const result = await runPublicEnvironment(root, {
        ...sentinelOptions(root),
        envCommand: providerCommand(root, "SAFE=yes\n"),
      });
      assertInvalidEnvironment(root, result, "Application env file could not be inspected");
      assert.equal(readFileSync(join(root, ".env.local"), "utf8"), content);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  });
}

for (const file of [
  ".env",
  ".env.test",
  ".env.test.local",
  ".env.development.local",
  ".env.production",
  ".env.staging.local",
]) {
  it(`MSG-07: screens ${file} without relying on env precedence`, async () => {
    const root = await runnerFixture();
    try {
      writeFileSync(join(root, file), `export CHECKOUT_KEY='  ${syntheticLiveKey}  '\n`);
      const result = await runPublicEnvironment(root, sentinelOptions(root), {
        NODE_ENV: "staging",
        CHECKOUT_KEY: syntheticTestKey,
      });
      const report = assertRefused(root, result);
      assert.ok(report.findings.some((finding) => finding.file === file));
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  });
}

it("MSG-07: provider-selected mode is checked before seed", async () => {
  const root = await runnerFixture();
  try {
    writeFileSync(join(root, ".env.preview.local"), `CHECKOUT_KEY=${syntheticLiveKey}\n`);
    const result = await runPublicEnvironment(root, {
      ...sentinelOptions(root),
      envCommand: providerCommand(root, "export NODE_ENV=preview\n"),
    });
    assertRefused(root, result);
    assert.equal(existsSync(join(root, "env.ran")), true);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

for (const [stage, syntax] of [
  ["env", "live"],
  ["seed", "live"],
  ["server", "live"],
  ["env", "uninspectable"],
  ["seed", "uninspectable"],
  ["server", "uninspectable"],
]) {
  it(`MSG-07: ${syntax} .env.local created by ${stage} blocks later children and cleans up server`, async () => {
    const root = await runnerFixture();
    try {
      writeFileSync(
        join(root, "planted-env"),
        syntax === "live"
          ? `CHECKOUT_KEY=${syntheticLiveKey}\n`
          : unsupportedDotenvInputs["braced expansion"],
      );
      const options = sentinelOptions(root);
      const plant = 'writeFileSync(".env.local", readFileSync("planted-env", "utf8"));';
      if (stage === "env") options.envCommand = providerCommand(root, "SAFE=yes\n", plant);
      if (stage === "seed")
        options.seedCommand = fixtureCommand(
          root,
          "seed",
          `import { readFileSync, writeFileSync } from "node:fs";
writeFileSync("seed.ran", "yes");
${plant}`,
        );
      if (stage === "server")
        appendFileSync(
          join(root, "server.mjs"),
          `\nimport { readFileSync } from "node:fs";\n${plant}\n`,
        );
      const result = await runPublicEnvironment(root, options);
      const later =
        stage === "env"
          ? ["seed", "server", "test"]
          : stage === "seed"
            ? ["server", "test"]
            : ["test"];
      if (syntax === "live") assertRefused(root, result, later);
      else
        assertInvalidEnvironment(
          root,
          result,
          "Application env file could not be inspected",
          later,
        );
      assert.equal(existsSync(join(root, `${stage}.ran`)), true);
      if (stage === "server") {
        const pid = Number(readFileSync(join(root, "server.pid"), "utf8"));
        assert.equal(await eventually(() => !processRunning(pid)), true, "server survived refusal");
      }
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  });
}

for (const kind of ["directory", "oversized", "dangling link"]) {
  it(`MSG-07: ${kind} env source fails closed before provider`, async () => {
    const root = await runnerFixture();
    try {
      const path = join(root, ".env.local");
      if (kind === "directory") mkdirSync(path);
      if (kind === "oversized")
        writeFileSync(path, `#${"x".repeat(512 * 1024)}\nCHECKOUT_KEY=${syntheticLiveKey}\n`);
      if (kind === "dangling link") symlinkSync("missing-env", path);
      const result = await runPublicEnvironment(root, {
        ...sentinelOptions(root),
        envCommand: providerCommand(root, "SAFE=yes\n"),
      });
      const report = JSON.parse(result.stdout) as MonkeyRunResult;
      assert.equal(result.code, 1);
      assert.ok(
        report.findings.some(
          (finding) =>
            finding.title === "Application env file could not be inspected" &&
            finding.file === ".env.local",
        ),
      );
      for (const stage of ["env", "seed", "server", "test"])
        assert.equal(existsSync(join(root, `${stage}.ran`)), false);
      assert.ok(!`${result.stdout}${result.stderr}`.includes(syntheticLiveKey));
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  });
}

it("MSG-07: sandbox dotenv stays app-owned; templates and unrelated mode files do not block seed", async () => {
  const root = await runnerFixture();
  try {
    const content = `export CHECKOUT_KEY=${syntheticTestKey}\n`;
    writeFileSync(join(root, ".env.local"), content);
    for (const file of [
      ".env.example",
      ".env.template",
      ".env.sample",
      ".env.unused",
      ".env.local.bak",
    ]) {
      writeFileSync(join(root, file), `CHECKOUT_KEY=${syntheticLiveKey}\n`);
    }
    const result = await runPublicEnvironment(root, {
      ...sentinelOptions(root),
      skipBrowser: true,
      seedCommand: fixtureCommand(
        root,
        "seed",
        `import { readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
const local = parseEnv(readFileSync(".env.local", "utf8"));
writeFileSync("seed.ran", !process.env.CHECKOUT_KEY && local.CHECKOUT_KEY?.startsWith(["sk", "test", ""].join("_")) ? "isolated" : "unexpected");`,
      ),
    });
    const report = JSON.parse(result.stdout) as MonkeyRunResult;
    assert.equal(readFileSync(join(root, "seed.ran"), "utf8"), "isolated");
    assert.ok(
      !report.findings.some((finding) =>
        /environment refused|could not be inspected/.test(finding.title),
      ),
    );
    assert.equal(readFileSync(join(root, ".env.local"), "utf8"), content);
    assert.ok(!`${result.stdout}${result.stderr}`.includes(syntheticTestKey));
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
