import assert from "node:assert/strict";
import { it } from "node:test";
import { checkEnvGitignored, gateStatus } from "./check-security.js";
import type { IgnoreCheckResult } from "./check-gitignore.js";

const protectedReport: IgnoreCheckResult = {
  exists: false,
  presentPatterns: [".env", ".env.local", ".env.*.local", ".env.keys"],
  missingPatterns: [],
  trackedFiles: [],
  unignoredFiles: [],
};

it("keeps the verdict in Kit and passes the governed directory to the inspector", async () => {
  const result = await checkEnvGitignored("governed", async (root) => {
    assert.equal(root, "governed");
    return protectedReport;
  });
  assert.equal(result.name, ".env gitignored");
  assert.equal(gateStatus(result), "pass");
});

it("fails when the required inspector is unavailable", async () => {
  const result = await checkEnvGitignored("governed", null);
  assert.equal(result.didNotRun, true);
  assert.equal(gateStatus(result, { lenient: true }), "fail");
});

it("reports a failed inspection and blocks the default gate", async () => {
  const result = await checkEnvGitignored("governed", async () => {
    throw new Error("inspection failed");
  });
  assert.equal(result.didNotRun, true);
  assert.equal(result.detail, "inspection failed");
  assert.equal(gateStatus(result), "fail");
});

it("refuses absent, incomplete or contradictory reports", async () => {
  for (const report of [
    null,
    { ...protectedReport, presentPatterns: [] },
    { ...protectedReport, trackedFiles: [".env"] },
    { ...protectedReport, unignoredFiles: [".env.keys"] },
  ]) {
    const result = await checkEnvGitignored("governed", async () => report);
    assert.equal(result.didNotRun, true);
    assert.equal(gateStatus(result, { lenient: true }), "fail");
  }
});
