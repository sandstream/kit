import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GITIGNORE_CONTENT, runCli } from "./cli-run.test-support.js";
import { FIXTURE_CONFIG_SECRET, FIXTURE_FULL_PIPELINE } from "./cli-fixtures.test-support.js";

const exec = promisify(execFile);
// `kit setup` runs the whole pipeline, including a security scan. On Windows CI one run took
// 25.6 s and the next was killed at the 30 s default (sandstream/kit#813), so allow more.
const SETUP_TIMEOUT_MS = 90_000;

describe("kit setup", () => {
  let tempDir: string;
  let fixtureEnv: Record<string, string>;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kit-integ-setup-"));
    const fixtureHome = join(tempDir, "home");
    await mkdir(fixtureHome);
    // Exercise this build in a disposable home, independent of the installed Kit version.
    fixtureEnv = {
      HOME: fixtureHome,
      USERPROFILE: fixtureHome,
      KIT_WRAPPER_ALLOW_DEV: "1",
    };
    await exec("git", ["init", "-q", tempDir]);
    await writeFile(join(tempDir, ".gitignore"), GITIGNORE_CONTENT, "utf-8");
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("runs all 6 pipeline steps with config-sourced secrets", async () => {
    await writeFile(join(tempDir, ".kit.toml"), FIXTURE_CONFIG_SECRET, "utf-8");

    const result = await runCli(["setup"], tempDir, fixtureEnv, SETUP_TIMEOUT_MS);

    // All steps should complete
    assert.ok(
      result.stdout.includes("[1/6]") && result.stdout.includes("[6/6]"),
      "should show pipeline step numbers",
    );
    // Config secrets always resolve → setup should succeed
    assert.equal(result.exitCode, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  });

  it("completes setup pipeline with node tool + config secrets", async () => {
    await writeFile(join(tempDir, ".kit.toml"), FIXTURE_FULL_PIPELINE, "utf-8");

    const result = await runCli(["setup"], tempDir, fixtureEnv, SETUP_TIMEOUT_MS);

    // node is already installed so install step should pass
    assert.ok(result.stdout.includes("[1/6]"), "should show step 1");
    // Verify final step ran
    assert.ok(result.stdout.includes("[6/6]"), "should show step 6");
    // Agent-config step should have wired a CLAUDE.md / AGENTS.md block
    assert.ok(result.stdout.includes("Agent config"), "should run the agent-config step");
  });
});

// ---------------------------------------------------------------------------
// kit check (with no default command arg — same as "check")
// ---------------------------------------------------------------------------
