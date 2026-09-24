import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runMonkeyTest } from "./monkey-test-runner.js";

describe("monkey-test browser skip fail-closed regression", () => {
  it("records both missing justification and missing browser evidence", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-monkey-browser-skip-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ devDependencies: { "@playwright/test": "1.0.0" } }),
    );

    try {
      const result = await runMonkeyTest(dir, {
        skipSecurity: true,
        skipBrowser: true,
        expectedReason: "",
        seedCommand: `node -e "process.exit(0)"`,
      });

      assert.equal(result.ok, false);
      assert.ok(
        result.findings.some(
          (finding) => finding.title === "--skip-browser requires --expected <reason>",
        ),
      );
      const skipped = result.findings.find(
        (finding) => finding.title === "Browser evidence skipped",
      );
      assert.equal(skipped?.severity, "critical");
      assert.equal(skipped?.repro, "kit monkey-test run --skip-browser");
      assert.ok(
        result.steps.some(
          (step) =>
            step.name === "browser" && step.status === "skip" && step.detail === "missing reason",
        ),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
