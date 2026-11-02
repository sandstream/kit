import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, mkdir, access, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { installFakeVercel } from "./cli-vercel-fixture.test-support.js";
import { GITIGNORE_CONTENT, runCli } from "./cli-run.test-support.js";
import {
  FIXTURE_DEPLOY_FIX,
  FIXTURE_EMPTY,
  FIXTURE_FULL_PIPELINE,
  FIXTURE_MANUAL_SERVICES,
} from "./cli-fixtures.test-support.js";

const exec = promisify(execFile);

describe("kit fix", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kit-integ-fix-"));
    await exec("git", ["init", "-q", tempDir]);
    await writeFile(join(tempDir, ".gitignore"), GITIGNORE_CONTENT, "utf-8");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("exits 0 when there is nothing to fix (empty config)", async () => {
    await writeFile(join(tempDir, ".kit.toml"), FIXTURE_EMPTY, "utf-8");
    const result = await runCli(["fix"], tempDir);
    assert.equal(result.exitCode, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  });

  it("generates missing lock files automatically", async () => {
    await writeFile(join(tempDir, ".kit.toml"), FIXTURE_FULL_PIPELINE, "utf-8");

    // Lock files should not exist yet
    const lockDir = join(tempDir, ".kit");
    let lockExisted = false;
    try {
      await access(join(lockDir, "skills-lock.json"));
      lockExisted = true;
    } catch {
      /* expected */
    }
    assert.equal(lockExisted, false, "lock file should not exist before fix");

    const result = await runCli(["fix"], tempDir);

    // fix should succeed
    assert.equal(result.exitCode, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);

    // Lock files should now exist
    const skillsLock = JSON.parse(await readFile(join(lockDir, "skills-lock.json"), "utf-8"));
    const cliLock = JSON.parse(await readFile(join(lockDir, "cli-lock.json"), "utf-8"));
    assert.equal(skillsLock.version, 1);
    assert.equal(cliLock.version, 1);
    // node should be in the CLI lock
    assert.ok(cliLock.tools.node, "node should be in cli-lock.json");
  });

  it("reports nothing to fix after lock files already exist", async () => {
    await writeFile(join(tempDir, ".kit.toml"), FIXTURE_EMPTY, "utf-8");

    // Run fix twice — second run should also succeed
    await runCli(["fix"], tempDir);
    const result = await runCli(["fix"], tempDir);
    assert.equal(result.exitCode, 0);
    assert.ok(
      result.stdout.includes("nothing") || result.stdout.includes("exist"),
      "should note that nothing needed fixing",
    );
  });

  it("prints human handoff for auth and DSN configuration", async () => {
    await writeFile(join(tempDir, ".kit.toml"), FIXTURE_MANUAL_SERVICES, "utf-8");

    const result = await runCli(["fix"], tempDir);

    assert.equal(result.exitCode, 1, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.match(result.stdout, /require human action/);
    assert.match(result.stdout, /HITL required/);
    assert.match(result.stdout, /Blocker: stripe is not authenticated/);
    assert.match(result.stdout, /Owner: provider admin/);
    assert.match(
      result.stdout,
      /Why the agent cannot resolve this: auth \/ browser \/ external account/,
    );
    assert.match(result.stdout, /Do this:/);
    assert.match(
      result.stdout,
      /Respond with: stripe configured\/authenticated; no secret values pasted/,
    );
    assert.match(result.stdout, /kit login --service stripe/);
    assert.match(result.stdout, /provider UI \/ external account \/ secret/);
    assert.match(result.stdout, /SENTRY_DSN, SENTRY_AUTH_TOKEN/);
    assert.match(result.stdout, /kit secrets set <KEY> --stdin/);
    assert.match(result.stdout, /Agent continues with: kit check --category services,secrets/);
  });

  it("reports non-kit hooks under core.hooksPath as manual, not fixed", async () => {
    await exec("git", ["init", "-q"], { cwd: tempDir });
    await exec("git", ["config", "core.hooksPath", ".githooks"], { cwd: tempDir });
    await mkdir(join(tempDir, ".githooks"), { recursive: true });
    await writeFile(join(tempDir, ".githooks", "pre-commit"), "#!/bin/sh\necho manual\n", "utf-8");
    await writeFile(join(tempDir, ".githooks", "pre-push"), "#!/bin/sh\necho manual\n", "utf-8");
    await chmod(join(tempDir, ".githooks", "pre-commit"), 0o755);
    await chmod(join(tempDir, ".githooks", "pre-push"), 0o755);
    await writeFile(
      join(tempDir, ".kit.toml"),
      '[hooks]\npre-commit = ["kit security scan-staged"]\npre-push = ["npm audit --audit-level=high"]\n',
      "utf-8",
    );

    const result = await runCli(["fix"], tempDir);

    assert.equal(result.exitCode, 1, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.match(result.stdout, /pre-commit hook was left untouched/);
    assert.match(result.stdout, /pre-push hook was left untouched/);
    assert.match(result.stdout, /require human action/);

    const preCommit = await readFile(join(tempDir, ".githooks", "pre-commit"), "utf-8");
    const prePush = await readFile(join(tempDir, ".githooks", "pre-push"), "utf-8");
    assert.doesNotMatch(preCommit, /# Generated by kit/);
    assert.doesNotMatch(preCommit, /kit security scan-staged/);
    assert.doesNotMatch(prePush, /# Generated by kit/);
    assert.doesNotMatch(prePush, /npm audit --audit-level=high/);
  });

  it("pushes missing deploy env values from declared secrets without echoing values", async () => {
    await writeFile(join(tempDir, ".kit.toml"), FIXTURE_DEPLOY_FIX, "utf-8");
    const logPath = join(tempDir, "vercel.log");
    const { env } = await installFakeVercel(tempDir, "push");

    const result = await runCli(["fix"], tempDir, env);

    assert.equal(result.exitCode, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.match(result.stdout, /NEXT_PUBLIC_SENTRY_ENVIRONMENT/);
    assert.match(result.stdout, /Redeploy required/);
    assert.doesNotMatch(result.stdout, /super-secret-env-value/);

    const log = await readFile(logPath, "utf-8");
    assert.match(log, /env rm NEXT_PUBLIC_SENTRY_ENVIRONMENT production/);
    assert.match(log, /env add NEXT_PUBLIC_SENTRY_ENVIRONMENT production/);
    assert.doesNotMatch(log, /super-secret-env-value/);
  });
});

// ---------------------------------------------------------------------------
// kit setup (end-to-end pipeline)
// ---------------------------------------------------------------------------
