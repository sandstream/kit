import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, it } from "node:test";
import { runShell, stopProcess } from "./monkey-test-process.js";

function nodeShellCommand(source: string): string {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(source)}`;
}

describe("monkey-test process runner", () => {
  it("redacts command output with secrets from the temporary environment", async () => {
    const secret = "sk_test_process_runner_secret_123456";
    const result = await runShell(
      nodeShellCommand(
        "process.stdout.write(process.env.TEST_SECRET); process.stderr.write(process.env.TEST_SECRET)",
      ),
      {
        cwd: process.cwd(),
        env: { ...process.env, TEST_SECRET: secret },
        timeoutMs: 5_000,
      },
    );

    assert.equal(result.ok, true);
    assert.doesNotMatch(result.stdout, new RegExp(secret));
    assert.doesNotMatch(result.stderr, new RegExp(secret));
    assert.match(result.stdout, /\[REDACTED\]/);
    assert.match(result.stderr, /\[REDACTED\]/);
  });

  it("times out and terminates a command that ignores SIGTERM", async () => {
    const result = await runShell(
      nodeShellCommand('process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'),
      { cwd: process.cwd(), env: process.env, timeoutMs: 25 },
    );

    assert.equal(result.ok, false);
    assert.equal(result.timedOut, true);
  });

  it("stops a detached process tree", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: process.platform !== "win32",
      stdio: "ignore",
    });
    await once(child, "spawn");

    try {
      assert.equal(await stopProcess(child), true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });
});
