import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { executeCommand } from "./run.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

it("accepts output exactly at the configured byte limit", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "kit-run-output-boundary-"));
  t.after(() => rmTemp(cwd));
  const result = await executeCommand({
    commandArgs: [process.execPath, "-e", "require('node:fs').writeSync(1, 'x'.repeat(64))"],
    cwd,
    streamOutput: false,
    stdin: "ignore",
    maxOutputBytes: 64,
    timeoutMs: 5000,
  });
  assert.equal(result.truncated, undefined);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "x".repeat(64));
});

it("output limits remain failures when the child exits before the kill takes effect", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "kit-run-output-status-"));
  t.after(() => rmTemp(cwd));
  // Exercise the race between output delivery, normal exit, and the parent's kill request.
  for (let attempt = 0; attempt < 25; attempt++) {
    const result = await executeCommand({
      commandArgs: [
        process.execPath,
        "-e",
        "require('node:fs').writeSync(1, 'x'.repeat(4096)); process.exit(0)",
      ],
      cwd,
      streamOutput: false,
      stdin: "ignore",
      maxOutputBytes: 64,
      timeoutMs: 5000,
    });
    assert.equal(result.truncated, true);
    assert.equal(
      result.exitCode,
      124,
      `attempt ${attempt}: truncated output cannot report success`,
    );
  }
});
