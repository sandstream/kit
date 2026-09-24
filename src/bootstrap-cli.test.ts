import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const commandUrl = new URL("../dist/commands/bootstrap.js", import.meta.url);

function runBootstrap(extraArgs: string[], policySourceEnv = "") {
  const root = mkdtempSync(join(tmpdir(), "kit-bootstrap-cli-"));
  const log = join(root, "steps.jsonl");
  const wrapper = join(root, "kit-stub.mjs");
  writeFileSync(join(root, ".kit-policy.signers"), '{"signers":[]}\n');
  writeFileSync(
    wrapper,
    `import { appendFileSync } from "node:fs";
import { cmdBootstrap } from ${JSON.stringify(commandUrl.href)};
if (process.argv[2] === "bootstrap") {
  process.exit((await cmdBootstrap()) ? 0 : 1);
}
appendFileSync(process.env.KIT_BOOTSTRAP_TEST_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
`,
  );
  try {
    const run = spawnSync(process.execPath, [wrapper, "bootstrap", "--json", ...extraArgs], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, KIT_POLICY_SOURCE: policySourceEnv, KIT_BOOTSTRAP_TEST_LOG: log },
    });
    const steps = existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as string[])
      : [];
    return { run, steps };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("bootstrap command policy source", () => {
  it("passes --policy-source to the policy pull child", () => {
    const { run, steps } = runBootstrap(["--policy-source", "/org/policy"]);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(steps, [
      ["setup", "--recommended"],
      ["identity", "init"],
      ["policy", "pull", "/org/policy"],
    ]);
    assert.equal(JSON.parse(run.stdout).ok, true);
  });

  it("accepts KIT_POLICY_SOURCE when no flag was supplied", () => {
    const { run, steps } = runBootstrap([], "/env/policy");
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(steps.at(-1), ["policy", "pull", "/env/policy"]);
  });

  it("fails closed before policy pull when an anchored repo has no source", () => {
    const { run, steps } = runBootstrap([]);
    assert.equal(run.status, 1, run.stderr);
    assert.deepEqual(steps, [
      ["setup", "--recommended"],
      ["identity", "init"],
    ]);
    const receipt = JSON.parse(run.stdout);
    assert.equal(receipt.ok, false);
    assert.match(receipt.steps.at(-1).detail, /policy source/i);
  });
});
