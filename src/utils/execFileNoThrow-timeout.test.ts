import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileNoThrow } from "./execFileNoThrow.js";

const SLEEP = ["-e", "setTimeout(() => {}, 30000)"];

describe("execFileNoThrow timeout", () => {
  it("marks a process that the timeout killed", async () => {
    const r = await execFileNoThrow(process.execPath, SLEEP, { timeout: 300 });
    assert.equal(r.ok, false);
    assert.equal(r.timedOut, true);
    assert.notEqual(r.truncated, true);
  });

  it("does not mark an ordinary failure or a success", async () => {
    const failed = await execFileNoThrow(process.execPath, ["-e", "process.exit(2)"]);
    assert.notEqual(failed.timedOut, true);
    const fine = await execFileNoThrow(process.execPath, ["-e", ""]);
    assert.notEqual(fine.timedOut, true);
  });

  it("does not call a cut-off report a timeout", async () => {
    const big = [
      "-e",
      "process.stdout.write('x'.repeat(2 * 1024 * 1024)); setTimeout(() => {}, 30000)",
    ];
    const r = await execFileNoThrow(process.execPath, big, {
      maxBuffer: 1024 * 1024,
      timeout: 5000,
    });
    assert.equal(r.truncated, true);
    assert.notEqual(r.timedOut, true);
  });
});
