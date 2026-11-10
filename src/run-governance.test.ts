import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { readAuditLog } from "./audit.js";
import { governanceFixture } from "./governance-outcome.test-support.js";
import { executeGovernedCommand } from "./run-governance.js";

for (const interactiveApproval of [false, true]) {
  for (const failure of ["timeout", "output"] as const) {
    it(`records ${failure} as failure through both audit layers (interactive=${interactiveApproval})`, async (t) => {
      const { target } = governanceFixture(t);
      writeFileSync(
        join(target, ".kit-exec-broker.json"),
        JSON.stringify({
          egress: { allow: [] },
          fs: { root: target },
          env: { declared: [] },
        }),
      );
      const script =
        failure === "timeout"
          ? "setInterval(() => {}, 1000)"
          : "process.stdout.write('x'.repeat(4096)); setInterval(() => {}, 1000)";
      const outcome = await executeGovernedCommand({
        commandArgs: [process.execPath, "-e", script],
        cwd: target,
        interactiveApproval,
        streamOutput: false,
        stdin: "ignore",
        timeoutMs: failure === "timeout" ? 50 : 5000,
        maxOutputBytes: failure === "output" ? 64 : 4096,
      });
      assert.equal(outcome.ok, false);
      assert.equal(outcome.result?.exitCode, 124);
      assert.equal(
        failure === "timeout" ? outcome.result?.timedOut : outcome.result?.truncated,
        true,
      );
      const expectedError = failure === "timeout" ? /timed out/ : /output exceeded/;
      assert.match(outcome.reason ?? "", expectedError);
      const events = (await readAuditLog(join(target, ".kit-audit.jsonl"))).filter(
        (event) => event.metadata?.phase !== "authorized",
      );
      assert.equal(events.length, 2);
      assert.ok(
        events.every((event) => !event.success && expectedError.test(event.error ?? "")),
        JSON.stringify(events),
      );
    });
  }
}
