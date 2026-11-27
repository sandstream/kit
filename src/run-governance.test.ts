import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { readAuditLog } from "./audit.js";
import { governanceFixture, projectConfig } from "./governance-outcome.test-support.js";
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

it("redacts every [secrets.keys] value from the run audit event and output, whatever its name or length", async (t) => {
  const { target } = governanceFixture(t);
  writeFileSync(
    join(target, ".kit-exec-broker.json"),
    JSON.stringify({ egress: { allow: [] }, fs: { root: target }, env: { declared: [] } }),
  );
  // Neither name is secret-shaped (no KEY/TOKEN/SECRET/...), and the PIN is under 8 characters.
  const salt = "fixture-long-value-abcdef-0002";
  writeFileSync(
    join(target, ".kit.toml"),
    `${projectConfig}[secrets]\nstore = "env"\n[secrets.keys.DEMO_SIGNING_SALT]\nsource = "config"\nvalue = "${salt}"\n[secrets.keys.DEMO_PIN]\nsource = "env"\n`,
  );
  writeFileSync(join(target, ".env.local"), `DEMO_SIGNING_SALT=${salt}\nDEMO_PIN=4821\n`);
  const outcome = await executeGovernedCommand({
    commandArgs: [
      process.execPath,
      "-e",
      "console.log(process.argv.slice(1).join(' '))",
      salt,
      "4821",
      "48219",
    ],
    cwd: target,
    streamOutput: false,
    stdin: "ignore",
  });
  assert.equal(outcome.ok, true, outcome.reason);
  const log = readFileSync(join(target, ".kit-audit.jsonl"), "utf-8");
  const runEvent = (await readAuditLog(join(target, ".kit-audit.jsonl"))).find(
    (event) => event.operation === "run",
  );
  assert.ok(runEvent, log);
  assert.ok(!log.includes(salt), log);
  assert.doesNotMatch(log, /\b4821\b/);
  // Exact-token matching: a longer number that merely contains the PIN is left alone.
  assert.match(String(runEvent.metadata?.command), /"\[REDACTED\]" "\[REDACTED\]" "48219"/);
  assert.equal(outcome.result?.stdout.trim(), "[REDACTED] [REDACTED] 48219");
});
