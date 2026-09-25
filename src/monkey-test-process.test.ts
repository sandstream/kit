import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
      nodeShellCommand("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"),
      { cwd: process.cwd(), env: process.env, timeoutMs: 25 },
    );

    assert.equal(result.ok, false);
    assert.equal(result.timedOut, true);
  });

  it(
    "closes a timed-out Windows shell and its child process",
    { skip: process.platform !== "win32" },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "kit-monkey-tree-"));
      const pidFile = join(dir, "child.pid");
      let pid = 0;
      try {
        const command = nodeShellCommand(
          "require('node:fs').writeFileSync(process.env.CHILD_PID_FILE, String(process.pid)); setInterval(() => {}, 1000)",
        );
        const result = await runShell(command, {
          cwd: dir,
          env: { ...process.env, CHILD_PID_FILE: pidFile },
          timeoutMs: 1_000,
        });
        pid = Number(readFileSync(pidFile, "utf8"));
        assert.equal(result.timedOut, true);
        assert.equal(result.ok, false);
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      } finally {
        if (pid) spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"]);
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

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
