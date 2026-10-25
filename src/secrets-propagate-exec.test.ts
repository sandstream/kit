import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { safeDiagnostic, spawnWithStdin } from "./secrets-propagate-exec.js";

describe("safeDiagnostic", () => {
  it("keeps one line and cuts it to the limit", () => {
    assert.equal(safeDiagnostic("first\nsecond"), "first");
    assert.equal(safeDiagnostic("x".repeat(500)).length, 300);
    assert.equal(safeDiagnostic("abcdef", [], 3), "abc");
  });

  it("redacts a known value from an error message", () => {
    const text = safeDiagnostic(new Error("failed with s3cr3t-value-12345"), [
      "s3cr3t-value-12345",
    ]);
    assert.ok(!text.includes("s3cr3t-value-12345"));
  });
});

describe("spawnWithStdin", () => {
  it("reports the exit code of a child that quits without reading stdin (no EPIPE crash)", async () => {
    // A CLI that rejects its arguments exits at once. The write to its stdin then fails with
    // EPIPE, which must not escape as an uncaught exception: the exit code is the answer.
    for (let i = 0; i < 20; i++) {
      const r = await spawnWithStdin(
        process.execPath,
        ["-e", "process.exit(5)"],
        "x".repeat(1 << 20),
      );
      assert.equal(r.code, 5);
    }
  });

  it("passes the value on stdin and reports the exit code", async () => {
    const r = await spawnWithStdin(
      process.execPath,
      ["-e", "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.exit(d==='abc'?0:3))"],
      "abc",
    );
    assert.equal(r.code, 0);
  });

  it("returns the exit code of a failing child and redacts the value in stderr", async () => {
    const r = await spawnWithStdin(
      process.execPath,
      ["-e", "console.error('echo '+require('fs').readFileSync(0,'utf8'));process.exit(2)"],
      "topsecret-value-98765",
    );
    assert.equal(r.code, 2);
    assert.ok(!r.stderr.includes("topsecret-value-98765"));
  });

  it("reports 127 when the command does not exist", async () => {
    const r = await spawnWithStdin("kit-no-such-command-xyz", [], "v");
    assert.equal(r.code, 127);
  });
});
