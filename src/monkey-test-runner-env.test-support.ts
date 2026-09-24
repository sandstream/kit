/** Synthetic env inputs and isolated public entry points for safety regressions. */
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MonkeyRunOptions, MonkeyRunResult } from "./monkey-test-contract.js";
import { spawnRunnerScript, runnerEntry } from "./monkey-test-runner-subprocess.test-support.js";
import { fixtureCommand, markerCommand, serverCommand } from "./monkey-test-runner.test-support.js";

export const syntheticLiveKey = ["sk", "live", "syntheticMonkeyAuditOnly123456789"].join("_");
export const syntheticTestKey = ["sk", "test", "syntheticMonkeyAuditOnly123456789"].join("_");
const syntheticInvalidValue = ["synthetic", "InvalidEnvValue", "123456789"].join("");

export const unsupportedDotenvInputs = {
  "colon assignment": `CHECKOUT_KEY: ${syntheticLiveKey}\n`,
  "escaped carriage return": `CHECKOUT_KEY="\\r${syntheticLiveKey}\\r"\n`,
  "braced expansion": "PREFIX=sk\nCHECKOUT_KEY=${PREFIX}_live_syntheticMonkeyAuditOnly123456789\n",
  "plain expansion": "MODE=live\nMONKEY_PAYMENT_MODE=$MODE\n",
  "dotted expansion": "MONKEY_PAYMENT_MODE=$.MODE\n",
  "escaped expansion": "MODE=live\nMONKEY_PAYMENT_MODE=\\$MODE\n",
  "command substitution": "MONKEY_PAYMENT_MODE=$(printf live)\n",
  "escaped quote": `LABEL="quoted\\" label"\nCHECKOUT_KEY=${syntheticLiveKey}\n`,
  "unterminated quote": 'CHECKOUT_KEY="unfinished\n',
  "NUL value": `MONKEY_INPUT=${syntheticInvalidValue}\0tail\n`,
};

const standardEnv = {
  KIT_NON_INTERACTIVE: "1",
  KIT_BUMBLEBEE: "0",
  KIT_NO_FAILURE_SIM: "1",
  KIT_NO_UPDATE_CHECK: "1",
  KIT_AUDIT_ANCHOR: "0",
};

export function providerCommand(root: string, output: string, extra = ""): string {
  writeFileSync(join(root, "provider-output"), output);
  return fixtureCommand(
    root,
    "env",
    `import { readFileSync, writeFileSync } from "node:fs";
writeFileSync("env.ran", "yes");
${extra}
process.stdout.write(readFileSync("provider-output", "utf8"));`,
  );
}

export function sentinelOptions(root: string): MonkeyRunOptions {
  return {
    skipSecurity: true,
    expectedReason: "Synthetic env safety audit fixture",
    seedCommand: markerCommand(root, "seed"),
    startCommand: serverCommand(root),
    testCommand: markerCommand(root, "test"),
  };
}

async function runIsolated(root: string, script: string, env: NodeJS.ProcessEnv) {
  const setup = `Object.assign(process.env, ${JSON.stringify({ ...standardEnv, ...env })});`;
  const run = spawnRunnerScript(root, setup + script);
  const timer = setTimeout(() => run.child.kill("SIGKILL"), 12_000);
  try {
    const exit = await run.exited;
    await run.closed;
    assert.equal(exit.signal, null, "isolated env fixture timed out");
    return { ...exit, ...run.output() };
  } finally {
    clearTimeout(timer);
  }
}

export async function runPublicEnvironment(
  root: string,
  options: MonkeyRunOptions,
  env: NodeJS.ProcessEnv = {},
) {
  return runIsolated(
    root,
    `const { runMonkeyTest } = await import(${JSON.stringify(runnerEntry())});
const before = JSON.stringify(process.env);
const result = await runMonkeyTest(process.cwd(), ${JSON.stringify(options)});
if (before !== JSON.stringify(process.env)) throw new Error("runner mutated caller environment");
console.log(JSON.stringify(result));
process.exitCode = result.ok ? 0 : 1;`,
    env,
  );
}

export async function runEnvironmentCli(root: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const cli = new URL(`./cli.${extension}`, import.meta.url);
  return runIsolated(
    root,
    `process.argv = [process.execPath, ${JSON.stringify(fileURLToPath(cli))}, "monkey-test", ...${JSON.stringify(args)}];
await import(${JSON.stringify(cli.href)});`,
    env,
  );
}

export function assertRefused(
  root: string,
  result: { code: number | null; stdout: string; stderr: string },
  stages = ["seed", "server", "test"],
): MonkeyRunResult {
  assert.equal(result.code, 1, "live env must fail the run");
  assert.ok(!`${result.stdout}${result.stderr}`.includes(syntheticLiveKey), "live value leaked");
  const report = JSON.parse(result.stdout) as MonkeyRunResult;
  assert.equal(report.ok, false);
  assert.ok(
    report.findings.some(
      (finding) =>
        finding.title === "Live payment environment refused" && finding.severity === "critical",
    ),
    "missing live payment refusal",
  );
  for (const stage of stages) {
    assert.equal(
      existsSync(join(root, `${stage}.ran`)),
      false,
      `${stage} ran after live env detection`,
    );
  }
  return report;
}

export function assertInvalidEnvironment(
  root: string,
  result: { code: number | null; stdout: string; stderr: string },
  title: string,
  stages = ["env", "seed", "server", "test"],
): MonkeyRunResult {
  assert.equal(result.code, 1);
  const output = `${result.stdout}${result.stderr}`;
  for (const value of [syntheticLiveKey, syntheticInvalidValue])
    assert.ok(!output.includes(value), "env value leaked");
  const report = JSON.parse(result.stdout) as MonkeyRunResult;
  assert.equal(report.ok, false);
  assert.ok(
    report.findings.some((finding) => finding.title === title && finding.severity === "critical"),
  );
  for (const stage of stages)
    assert.equal(existsSync(join(root, `${stage}.ran`)), false, `${stage} ran after env refusal`);
  return report;
}
