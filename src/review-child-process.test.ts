import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { it } from "node:test";
import { captureChildStderr, requireChildExit } from "./review-child-process.test-support.js";

it("accepts an intentional nonzero child exit", () => {
  const result = spawnSync(process.execPath, ["-e", "process.exit(7)"], { encoding: "utf8" });
  assert.equal(requireChildExit(result, "fixture").status, 7);
});

it("reports a timed out child instead of treating it as an expected failure", () => {
  const result = spawnSync(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    encoding: "utf8",
    timeout: 1000,
  });
  assert.throws(
    () => requireChildExit(result, "fixture"),
    /fixture did not exit normally[\s\S]*ETIMEDOUT/,
  );
});

it("captures an early child failure for diagnostic output", async () => {
  const child = spawn(
    process.execPath,
    ["-e", "process.stderr.write('fixture details'); process.exit(3)"],
    {
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  const stderr = captureChildStderr(child);
  const status = await new Promise<number | null>((done) => child.once("close", done));
  assert.equal(status, 3);
  assert.equal(stderr(), "fixture details");
});
