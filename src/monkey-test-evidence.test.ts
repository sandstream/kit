import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runnerRoleMatrixFinding, validatePlaywrightEvidence } from "./monkey-test-evidence.js";

describe("monkey-test evidence", () => {
  it("rejects absent or stale browser evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "kit-monkey-evidence-"));
    try {
      assert.equal((await validatePlaywrightEvidence(root, "current")).ok, false);
      await mkdir(join(root, ".kit", "monkey-test"), { recursive: true });
      await writeFile(
        join(root, ".kit", "monkey-test", "playwright-report.json"),
        JSON.stringify({ config: { metadata: { kitMonkeyContract: 1, kitMonkeyRunId: "stale" } } }),
      );
      assert.match((await validatePlaywrightEvidence(root, "current")).detail, /current/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns a critical finding when role evidence is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "kit-monkey-role-evidence-"));
    try {
      const finding = await runnerRoleMatrixFinding(root, {});
      assert.equal(finding?.severity, "critical");
      assert.equal(finding?.area, "authz");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
