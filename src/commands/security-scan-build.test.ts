import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdSecurityScanBuild } from "./security-scan-build.js";
import { rmTemp } from "../temp-cleanup.test-support.js";

async function runScan(dir: string): Promise<{ ok: boolean; output: string }> {
  const originalCwd = process.cwd();
  const originalArgs = process.argv;
  const originalLog = console.log;
  const originalError = console.error;
  const output: string[] = [];
  try {
    process.chdir(dir);
    process.argv = ["node", "kit", "security", "scan-build"];
    console.log = (...args: unknown[]) => void output.push(args.join(" "));
    console.error = (...args: unknown[]) => void output.push(args.join(" "));
    return { ok: await cmdSecurityScanBuild(), output: output.join("\n") };
  } finally {
    process.chdir(originalCwd);
    process.argv = originalArgs;
    console.log = originalLog;
    console.error = originalError;
  }
}

describe("kit security scan-build", () => {
  it("fails an incomplete scan without claiming no matches", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-scan-build-cmd-"));
    try {
      mkdirSync(join(dir, "dist"));
      writeFileSync(join(dir, "dist", "broken.js.map"), "{");
      const result = await runScan(dir);
      assert.equal(result.ok, false);
      assert.match(result.output, /scan-build: incomplete/);
      assert.match(result.output, /dist\/broken\.js\.map/);
      assert.doesNotMatch(result.output, /no matches/);
    } finally {
      rmTemp(dir);
    }
  });

  it("reports known findings when another artifact cannot be scanned", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-scan-build-cmd-"));
    try {
      mkdirSync(join(dir, "dist"));
      writeFileSync(join(dir, "dist", "broken.js.map"), "{");
      writeFileSync(join(dir, "dist", "leak.js"), "sk_" + "live_AbCdEfGhIjKlMnOpQrStUvWxYz123");
      const result = await runScan(dir);
      assert.equal(result.ok, false);
      assert.match(result.output, /scan-build: incomplete/);
      assert.match(result.output, /dist\/broken\.js\.map/);
      assert.match(result.output, /dist\/leak\.js/);
      assert.match(result.output, /stripe-key/);
      assert.doesNotMatch(result.output, /no matches/);
    } finally {
      rmTemp(dir);
    }
  });

  it("reports no matches when a complete scan is clean", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-scan-build-cmd-"));
    try {
      mkdirSync(join(dir, "dist"));
      writeFileSync(join(dir, "dist", "safe.js"), "export const value = 1;");
      const result = await runScan(dir);
      assert.equal(result.ok, true);
      assert.match(result.output, /scan-build: no matches/);
      assert.doesNotMatch(result.output, /incomplete/);
    } finally {
      rmTemp(dir);
    }
  });
});
