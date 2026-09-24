import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import type { MonkeyRunResult } from "./monkey-test-contract.js";
import { markerCommand, runnerFixture, serverCommand } from "./monkey-test-runner.test-support.js";
import { runMonkey } from "./monkey-test-runner-subprocess.test-support.js";

for (const [name, baseUrl, title] of [
  ["remote", "http://example.invalid:3199", "Invalid base URL"],
  ["unreachable local", "http://127.0.0.1:1", "Base URL is not reachable"],
] as const) {
  it(`MSG-11: ${name} base URL blocks seed before browser work`, async () => {
    const root = await runnerFixture();
    try {
      const result = await runMonkey(root, [
        "--json",
        "--base-url",
        baseUrl,
        "--seed-command",
        markerCommand(root, "seed"),
        "--start-command",
        serverCommand(root),
        "--test-command",
        markerCommand(root, "test"),
      ]);
      assert.equal(result.code, 1, result.stderr);
      const report = JSON.parse(result.stdout) as MonkeyRunResult;
      assert.ok(report.findings.some((finding) => finding.title === title));
      assert.equal(existsSync(join(root, "seed.ran")), false);
      assert.equal(existsSync(join(root, "server.ran")), false);
      assert.equal(existsSync(join(root, "test.ran")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
