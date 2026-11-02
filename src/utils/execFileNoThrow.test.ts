import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileNoThrow } from "./execFileNoThrow.js";

const TWO_MIB = ["-e", "process.stdout.write('x'.repeat(2 * 1024 * 1024))"];

describe("execFileNoThrow output limit", () => {
  it("marks a result truncated when the output exceeds maxBuffer", async () => {
    const r = await execFileNoThrow(process.execPath, TWO_MIB, { maxBuffer: 1024 * 1024 });
    assert.equal(r.ok, false);
    assert.equal(r.truncated, true);
  });

  it("returns the whole output when the caller raises maxBuffer", async () => {
    const r = await execFileNoThrow(process.execPath, TWO_MIB, { maxBuffer: 8 * 1024 * 1024 });
    assert.equal(r.ok, true);
    assert.equal(r.stdout.length, 2 * 1024 * 1024);
    assert.notEqual(r.truncated, true);
  });

  it("does not mark an ordinary failure as truncated", async () => {
    const r = await execFileNoThrow(process.execPath, ["-e", "process.exit(3)"]);
    assert.equal(r.exitCode, 3);
    assert.notEqual(r.truncated, true);
  });
});
