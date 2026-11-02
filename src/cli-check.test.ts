import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { installFakeVercel } from "./cli-vercel-fixture.test-support.js";
import { GITIGNORE_CONTENT, runCli } from "./cli-run.test-support.js";
import {
  FIXTURE_CONFIG_SECRET,
  FIXTURE_DEPLOY_MISSING,
  FIXTURE_EMPTY,
  FIXTURE_ENV_SECRET,
  FIXTURE_MANUAL_SERVICES,
  FIXTURE_MISSING_ENV_SECRET,
  FIXTURE_NODE_TOOL,
} from "./cli-fixtures.test-support.js";

const exec = promisify(execFile);

describe("kit check", () => {
  let tempDir: string;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kit-integ-check-"));
    await exec("git", ["init", "-q", tempDir]);
    await writeFile(join(tempDir, ".gitignore"), GITIGNORE_CONTENT, "utf-8");
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("exits 0 with empty config (no tools/services/secrets configured)", async () => {
    await writeFile(join(tempDir, ".kit.toml"), FIXTURE_EMPTY, "utf-8");
    const result = await runCli(["check"], tempDir);
    assert.equal(result.exitCode, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  });

  it("exits 0 when all secrets use config source (always available)", async () => {
    await writeFile(join(tempDir, ".kit.toml"), FIXTURE_CONFIG_SECRET, "utf-8");
    const result = await runCli(["check"], tempDir);
    assert.equal(result.exitCode, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  });

  it("exits 0 when env secrets are present", async () => {
    await writeFile(join(tempDir, ".kit.toml"), FIXTURE_ENV_SECRET, "utf-8");
    const result = await runCli(["check"], tempDir, {
      _KIT_INTEG_SECRET: "test-value",
    });
    assert.equal(result.exitCode, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  });

  it("exits 1 when a required env secret is missing", async () => {
    await writeFile(join(tempDir, ".kit.toml"), FIXTURE_MISSING_ENV_SECRET, "utf-8");
    await runCli(["check"], tempDir, {
      // Ensure the var is absent
      _KIT_DEFINITELY_ABSENT_XYZ: "",
    });
    // Either 0 or 1 depending on how env treats empty string;
    // with no value set at all, it should definitely fail
    const result2 = await runCli(["check"], tempDir);
    // _KIT_DEFINITELY_ABSENT_XYZ should not be in the environment
    assert.equal(result2.exitCode, 1);
  });

  it("produces output listing checked items", async () => {
    await writeFile(join(tempDir, ".kit.toml"), FIXTURE_CONFIG_SECRET, "utf-8");
    const result = await runCli(["check"], tempDir);
    // Should show some output (tables, status indicators)
    assert.ok(result.stdout.length > 0, "should produce non-empty output");
  });
});

describe("kit check: services, deploy and tools", () => {
  let tempDir: string;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kit-integ-check-"));
    await exec("git", ["init", "-q", tempDir]);
    await writeFile(join(tempDir, ".gitignore"), GITIGNORE_CONTENT, "utf-8");
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("prints HITL blocks for service auth and DSN/secret setup gaps", async () => {
    await writeFile(join(tempDir, ".kit.toml"), FIXTURE_MANUAL_SERVICES, "utf-8");

    const result = await runCli(["check", "--category", "services,secrets"], tempDir);

    assert.equal(result.exitCode, 1, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.match(result.stdout, /HITL required/);
    assert.match(result.stdout, /Blocker: stripe is not authenticated/);
    assert.match(result.stdout, /Blocker: sentry requires manual provider configuration/);
    assert.match(
      result.stdout,
      /Blocker: 2 env secrets unavailable: SENTRY_DSN, SENTRY_AUTH_TOKEN/,
    );
    assert.match(result.stdout, /Agent continues with: kit check --category services,secrets/);
  });

  it("checks declared deploy env names without printing remote values", async () => {
    await writeFile(join(tempDir, ".kit.toml"), FIXTURE_DEPLOY_MISSING, "utf-8");
    const { env } = await installFakeVercel(tempDir, "list");

    const result = await runCli(["check", "--category", "deploy"], tempDir, env);

    assert.equal(result.exitCode, 1, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.match(result.stdout, /Deploy/);
    assert.match(result.stdout, /NEXT_PUBLIC_SENTRY_ENVIRONMENT/);
    assert.doesNotMatch(result.stdout, /super-secret-dsn-value/);
  });

  it("exits 0 with node at latest (always installed)", async () => {
    await writeFile(join(tempDir, ".kit.toml"), FIXTURE_NODE_TOOL, "utf-8");
    // Initialize lock files first so the lock check doesn't fail
    await runCli(["fix"], tempDir);
    const result = await runCli(["check"], tempDir);
    // node is always installed; "latest" always satisfies
    assert.equal(result.exitCode, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  });
});

// ---------------------------------------------------------------------------
// kit fix
// ---------------------------------------------------------------------------
