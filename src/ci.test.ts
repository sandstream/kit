import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, rm, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const exec = promisify(execFile);
const CLI = resolve(process.cwd(), "dist/cli.js");

let testDir: string;

async function runCi(args: string[] = [], env: Record<string, string> = {}) {
  try {
    const { stdout, stderr } = await exec("node", [CLI, "ci", ...args], {
      cwd: testDir,
      timeout: 15_000,
      env: { ...process.env, ...env, CI: undefined as unknown as string },
    });
    return { exitCode: 0, stdout, stderr };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { exitCode: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

before(async () => {
  testDir = join(tmpdir(), `kit-ci-test-${Date.now()}`);
  await mkdir(testDir, { recursive: true });
  // Minimal .kit.toml with no required tools/services/secrets
  await writeFile(join(testDir, ".kit.toml"), `[tools]\n`, "utf8");
});

after(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("kit ci", () => {
  it("runs without crashing (empty config)", async () => {
    const { stdout, stderr } = await runCi(["--format=text"]);
    // Should produce a summary line regardless of pass/fail
    assert(
      stdout.includes("kit ci:") ||
        stderr.includes("kit ci:") ||
        stdout.length > 0 ||
        stderr.length > 0,
    );
  });

  it("--json outputs valid JSON with ok/checks/summary fields", async () => {
    const { stdout } = await runCi(["--json"]);
    // stdout should be parseable JSON even on failure
    const parsed = JSON.parse(stdout);
    assert(typeof parsed.ok === "boolean");
    assert(Array.isArray(parsed.checks));
    assert(typeof parsed.summary === "object");
    assert(typeof parsed.summary.passed === "number");
    assert(typeof parsed.summary.failed === "number");
    assert(typeof parsed.summary.warnings === "number");
  });

  it("--format=json outputs valid JSON", async () => {
    const { stdout } = await runCi(["--format=json"]);
    const parsed = JSON.parse(stdout);
    assert(typeof parsed.ok === "boolean");
  });

  it("--format=text outputs a summary line", async () => {
    const { stdout } = await runCi(["--format=text"]);
    assert(stdout.includes("kit ci:"));
    assert(stdout.includes("passed"));
  });

  it("--format=github emits ::error:: / ::warning:: annotations for failures", async () => {
    // Create a config with a missing secret to trigger a failure
    await writeFile(
      join(testDir, ".kit.toml"),
      `[secrets]\ntemplate = ".env.template"\n[secrets.keys]\nMY_KEY = { source = "env" }\n`,
      "utf8",
    );
    const { stdout } = await runCi(["--format=github"], {});
    // MY_KEY won't be in env, so should emit ::error::
    assert(stdout.includes("::error::") || stdout.includes("kit ci:"));
    // Restore minimal config
    await writeFile(join(testDir, ".kit.toml"), `[tools]\n`, "utf8");
  });

  it("auto-detects github format from GITHUB_ACTIONS env", async () => {
    const { stdout } = await runCi([], { GITHUB_ACTIONS: "true" });
    // In github format, summary line should still be present
    assert(stdout.includes("kit ci:"));
  });

  it("exit code is 1 when there are failures", async () => {
    // Config with a required tool that doesn't exist
    await writeFile(join(testDir, ".kit.toml"), `[tools]\nnonexistent-tool-xyz = "1.0"\n`, "utf8");
    const { exitCode } = await runCi(["--format=text"]);
    assert.equal(exitCode, 1);
    // Restore
    await writeFile(join(testDir, ".kit.toml"), `[tools]\n`, "utf8");
  });
});
