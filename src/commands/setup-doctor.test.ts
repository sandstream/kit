import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cmdDoctor } from "./setup.js";

describe("kit doctor output", () => {
  it("emits one machine-readable document for --json", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "kit-doctor-json-"));
    const previousArgv = process.argv;
    const previousCwd = process.cwd();
    const lines: string[] = [];
    const oldLog = console.log;
    const oldError = console.error;
    process.argv = [process.execPath, "kit", "doctor", "--json"];
    process.chdir(cwd);
    console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
    console.error = () => {};
    try {
      const ok = await cmdDoctor();
      const output = lines.join("\n");
      const parsed = JSON.parse(output) as {
        ok: boolean;
        passed: number;
        warnings: number;
        failed: number;
        skipped: number;
        checks: unknown[];
      };
      assert.equal(parsed.ok, ok);
      assert.equal(Array.isArray(parsed.checks), true);
      assert.equal(
        parsed.checks.length,
        parsed.passed + parsed.warnings + parsed.failed + parsed.skipped,
      );
    } finally {
      console.log = oldLog;
      console.error = oldError;
      process.chdir(previousCwd);
      process.argv = previousArgv;
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
