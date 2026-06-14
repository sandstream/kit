import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runStep, fmtDuration } from "./output.js";

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// Capture everything written to stdout (console.log + process.stdout.write),
// so assertions hold for both the TTY (rewrite) and non-TTY (line) branches.
function captureStdout(): { text: () => string; restore: () => void } {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: unknown }).write = (
    chunk: string | Uint8Array,
  ): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  };
  return {
    text: () => stripAnsi(chunks.join("")),
    restore: () => {
      (process.stdout as unknown as { write: unknown }).write = orig;
    },
  };
}

describe("fmtDuration", () => {
  it("renders sub-second values in milliseconds", () => {
    assert.equal(fmtDuration(0), "0ms");
    assert.equal(fmtDuration(250), "250ms");
    assert.equal(fmtDuration(999), "999ms");
  });

  it("renders one-decimal seconds at and above 1s", () => {
    assert.equal(fmtDuration(1000), "1.0s");
    assert.equal(fmtDuration(1540), "1.5s");
    assert.equal(fmtDuration(16000), "16.0s");
  });
});

describe("runStep", () => {
  it("returns the fn result and renders ▶ start + ✓ done with the label", async () => {
    const cap = captureStdout();
    let result: number;
    try {
      result = await runStep("build", async () => 42);
    } finally {
      cap.restore();
    }
    const out = cap.text();
    assert.equal(result, 42);
    assert.match(out, /▶.*build/);
    assert.match(out, /✓.*build/);
  });

  it("marks the step ✗ and re-throws when the fn rejects", async () => {
    const cap = captureStdout();
    let threw = false;
    try {
      await runStep("security scan", async () => {
        throw new Error("boom");
      });
    } catch (err) {
      threw = true;
      assert.match((err as Error).message, /boom/);
    } finally {
      cap.restore();
    }
    assert.ok(threw, "runStep re-throws the underlying error");
    assert.match(cap.text(), /✗.*security scan/);
  });
});
