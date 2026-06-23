import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeCommand } from "./run.js";

let tmpDir: string;

before(async () => {
  tmpDir = join(tmpdir(), `kit-run-test-${process.pid}`);
  await mkdir(tmpDir, { recursive: true });
});

after(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("executeCommand", () => {
  it("executes a simple command successfully", async () => {
    const result = await executeCommand({
      commandArgs: ["echo", "hello"],
      cwd: tmpDir,
    });

    assert.equal(result.exitCode, 0, "Should exit with code 0");
    assert(result.stdout.includes("hello"), "Should capture stdout");
  });

  it("passes environment variables from parent process", async () => {
    const originalKey = "TEST_KIT_RUN_VAR";
    const originalValue = "test-value-123";
    process.env[originalKey] = originalValue;

    const result = await executeCommand({
      commandArgs: ["node", "-e", `console.log(process.env.${originalKey})`],
      cwd: tmpDir,
      inheritEnv: true,
    });

    assert.equal(result.exitCode, 0, "Should exit with code 0");
    assert(result.stdout.includes(originalValue), "Should inherit parent env vars");

    delete process.env[originalKey];
  });

  it("loads .env.local variables", async () => {
    const envPath = join(tmpDir, ".env.local");
    await writeFile(envPath, "CUSTOM_VAR=custom-value\nANOTHER_VAR=another-value\n", "utf-8");

    const result = await executeCommand({
      commandArgs: ["node", "-e", "console.log(process.env.CUSTOM_VAR)"],
      cwd: tmpDir,
      inheritEnv: true,
    });

    assert.equal(result.exitCode, 0, "Should exit with code 0");
    assert(result.stdout.includes("custom-value"), "Should load .env.local variables");
  });

  it("applies env overrides", async () => {
    const result = await executeCommand({
      commandArgs: ["node", "-e", "console.log(process.env.OVERRIDE_VAR)"],
      cwd: tmpDir,
      envOverrides: { OVERRIDE_VAR: "overridden-value" },
      inheritEnv: true,
    });

    assert.equal(result.exitCode, 0, "Should exit with code 0");
    assert(result.stdout.includes("overridden-value"), "Should apply env overrides");
  });

  it("overrides .env.local with envOverrides", async () => {
    const envPath = join(tmpDir, ".env.local");
    await writeFile(envPath, "PRIORITY_VAR=from-env-file\n", "utf-8");

    const result = await executeCommand({
      commandArgs: ["node", "-e", "console.log(process.env.PRIORITY_VAR)"],
      cwd: tmpDir,
      envOverrides: { PRIORITY_VAR: "from-overrides" },
      inheritEnv: true,
    });

    assert.equal(result.exitCode, 0, "Should exit with code 0");
    assert(result.stdout.includes("from-overrides"), "Should prioritize envOverrides");
  });

  it("handles command exit codes", async () => {
    const result = await executeCommand({
      commandArgs: ["node", "-e", "process.exit(42)"],
      cwd: tmpDir,
    });

    assert.equal(result.exitCode, 42, "Should return the command exit code");
  });

  it("ignores .env.local if not found", async () => {
    const result = await executeCommand({
      commandArgs: ["echo", "success"],
      cwd: tmpDir,
    });

    assert.equal(result.exitCode, 0, "Should succeed even without .env.local");
  });

  it("handles command not found error", async () => {
    const result = await executeCommand({
      commandArgs: ["nonexistent-command-12345"],
      cwd: tmpDir,
    });

    assert.equal(result.exitCode, 127, "Should return exit code 127 for command not found");
    assert(
      result.stderr.includes("Failed to execute") || result.stderr !== "",
      "Should have error message",
    );
  });

  it("parses .env.local with comments", async () => {
    const envPath = join(tmpDir, ".env.local");
    await writeFile(
      envPath,
      "# This is a comment\nVAR_WITH_COMMENT=value-1\n# Another comment\nVAR2=value-2\n",
      "utf-8",
    );

    const result = await executeCommand({
      commandArgs: ["node", "-e", "console.log(process.env.VAR_WITH_COMMENT)"],
      cwd: tmpDir,
      inheritEnv: true,
    });

    assert.equal(result.exitCode, 0, "Should exit with code 0");
    assert(result.stdout.includes("value-1"), "Should parse .env.local ignoring comments");
  });

  it("uses isolated environment when inheritEnv is false", async () => {
    process.env.ISOLATED_TEST_VAR = "should-not-appear";

    // Use process.execPath (absolute path to node) — with inheritEnv:false
    // the child gets an empty PATH and can't resolve bare "node".
    const result = await executeCommand({
      commandArgs: [
        process.execPath,
        "-e",
        "console.log(process.env.ISOLATED_TEST_VAR || 'undefined')",
      ],
      cwd: tmpDir,
      inheritEnv: false,
      envOverrides: { ISOLATED_TEST_VAR: "should-appear" },
    });

    assert.equal(result.exitCode, 0, "Should exit with code 0");
    assert(result.stdout.includes("should-appear"), "Should use envOverrides in isolated env");

    delete process.env.ISOLATED_TEST_VAR;
  });

  it("captures stderr output", async () => {
    const result = await executeCommand({
      commandArgs: ["node", "-e", "console.error('error message')"],
      cwd: tmpDir,
    });

    assert.equal(result.exitCode, 0, "Should exit with code 0");
    assert(result.stderr.includes("error message"), "Should capture stderr");
  });

  it("handles multiline output correctly", async () => {
    const result = await executeCommand({
      commandArgs: [
        "node",
        "-e",
        "console.log('line1'); console.log('line2'); console.log('line3')",
      ],
      cwd: tmpDir,
    });

    assert.equal(result.exitCode, 0, "Should exit with code 0");
    assert(result.stdout.includes("line1"), "Should capture all lines");
    assert(result.stdout.includes("line2"), "Should capture all lines");
    assert(result.stdout.includes("line3"), "Should capture all lines");
  });

  it("throws error when no command is provided", async () => {
    try {
      await executeCommand({
        commandArgs: [],
        cwd: tmpDir,
      });
      assert.fail("Should throw error");
    } catch (err) {
      assert(err instanceof Error);
      assert(err.message.includes("No command provided"));
    }
  });

  it("preserves command exit code on parent process", async () => {
    const result = await executeCommand({
      commandArgs: ["node", "-e", "process.exit(5)"],
      cwd: tmpDir,
    });

    assert.equal(result.exitCode, 5, "Should preserve exit code");
  });
});
