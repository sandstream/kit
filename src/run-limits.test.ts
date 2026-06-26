import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeCommand } from "./run.js";

let tmpDir: string;

before(async () => {
  tmpDir = join(tmpdir(), `kit-run-limits-test-${process.pid}`);
  await mkdir(tmpDir, { recursive: true });
});

after(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("executeCommand resource limits", () => {
  it("kills a subprocess that exceeds timeoutMs", async () => {
    const result = await executeCommand({
      // Sleep far longer than the timeout — should be SIGKILLed.
      commandArgs: [process.execPath, "-e", "setTimeout(() => {}, 60000)"],
      cwd: tmpDir,
      timeoutMs: 200,
    });

    assert.equal(result.timedOut, true, "Should mark result as timed out");
    assert.notEqual(result.exitCode, 0, "Timed-out process should not report success");
    assert(result.stderr.includes("timed out"), "Should surface timeout in stderr");
  });

  it("truncates and kills a subprocess that exceeds maxOutputBytes", async () => {
    const result = await executeCommand({
      // Emit far more than the cap in a tight loop.
      commandArgs: [
        process.execPath,
        "-e",
        "for (let i = 0; i < 100000; i++) process.stdout.write('x'.repeat(1000))",
      ],
      cwd: tmpDir,
      maxOutputBytes: 4096,
    });

    assert.equal(result.truncated, true, "Should mark result as truncated");
    assert(result.stdout.length <= 4096, "Captured stdout must not exceed the cap");
    assert(result.stderr.includes("truncated"), "Should surface truncation in stderr");
  });

  it("does not flag short, fast commands", async () => {
    const result = await executeCommand({
      commandArgs: ["echo", "ok"],
      cwd: tmpDir,
      timeoutMs: 5000,
      maxOutputBytes: 1024,
    });

    assert.equal(result.exitCode, 0, "Should succeed");
    assert.equal(result.timedOut, undefined, "Should not be flagged as timed out");
    assert.equal(result.truncated, undefined, "Should not be flagged as truncated");
    assert(result.stdout.includes("ok"), "Should capture output");
  });
});
