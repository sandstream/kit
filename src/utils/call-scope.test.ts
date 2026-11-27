/** Where a "fail the run" lands: the process exit code on the CLI, the call inside a scope. */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { failCall, runInCallScope } from "./call-scope.js";

describe("call scope", () => {
  afterEach(() => {
    process.exitCode = 0;
  });

  it("outside a scope, a failure sets the process exit code (the CLI)", () => {
    failCall("x");
    assert.equal(process.exitCode, 1);
  });

  it("inside a scope, a failure is the call's alone, even with calls running concurrently", async () => {
    const tick = () => new Promise((r) => setImmediate(r));
    const [a, b] = await Promise.all([
      runInCallScope(async () => (await tick(), failCall("a failed"), "a")),
      runInCallScope(async () => (await tick(), await tick(), "b")),
    ]);
    assert.deepEqual(a, { value: "a", failures: ["a failed"] });
    assert.deepEqual(b, { value: "b", failures: [] });
    assert.notEqual(process.exitCode, 1);
  });
});
