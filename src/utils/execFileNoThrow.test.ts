import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileNoThrow, failedDetail } from "./execFileNoThrow.js";

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

describe("execFileNoThrow default limit", () => {
  it("reads a 2 MiB report without the caller raising maxBuffer", async () => {
    const r = await execFileNoThrow(process.execPath, TWO_MIB);
    assert.equal(r.ok, true);
    assert.equal(r.stdout.length, 2 * 1024 * 1024);
  });
});

describe("failedDetail", () => {
  const base = { stdout: "", stderr: "", exitCode: 1, ok: false };

  it("keeps the caller's message for an ordinary failure", () => {
    assert.equal(failedDetail("trivy scan failed", base), "trivy scan failed");
  });

  it("names the buffer when the output was cut off", () => {
    const detail = failedDetail("trivy scan failed", { ...base, truncated: true });
    assert.match(detail, /^trivy scan failed: /);
    assert.match(detail, /buffer limit/);
    assert.match(detail, /not a tool failure/);
  });
});
