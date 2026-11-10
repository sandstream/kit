import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkLicenses } from "./check-licenses.js";
import { execFileNoThrow, type ExecResult } from "./utils/execFileNoThrow.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const failure: ExecResult = { ok: false, stdout: "", stderr: "", exitCode: 1 };

for (const [name, output, expected] of [
  [
    "stdout error after stderr warning",
    { stdout: "Error: cannot read dependencies", stderr: "npm WARN deprecated" },
    /Error: cannot read dependencies/,
  ],
  ["timeout", { timedOut: true }, /time limit/],
  ["truncated output", { truncated: true }, /buffer limit/],
  ["empty failure", {}, /exit 1/],
  ["failure with a partial valid report", { stdout: "{}" }, /failed/],
  ["malformed report", { ok: true, exitCode: 0, stdout: "not json" }, /not a valid license report/],
  ["array report", { ok: true, exitCode: 0, stdout: "[]" }, /not a valid license report/],
  ["primitive report", { ok: true, exitCode: 0, stdout: "42" }, /not a valid license report/],
  [
    "invalid package entry",
    { ok: true, exitCode: 0, stdout: '{"x@1.0.0":42}' },
    /not a valid license report/,
  ],
] as const) {
  it(`keeps ${name} visible as an incomplete license scan`, async () => {
    const root = mkdtempSync(join(tmpdir(), "kit-license-result-"));
    try {
      writeFileSync(join(root, "package.json"), "{}");
      const result = await checkLicenses(root, {
        resolveToolBin: async () => "scanner",
        execFileNoThrow: async () => ({ ...failure, ...output }),
      });
      assert.equal(result.status, "warn");
      assert.equal(result.didNotRun, true);
      assert.match(result.detail, expected);
      assert.doesNotMatch(result.suggestion ?? "", /install/i);
    } finally {
      rmTemp(root);
    }
  });
}

it("preserves a copyleft finding when the scanner completes", async () => {
  const root = mkdtempSync(join(tmpdir(), "kit-license-finding-"));
  try {
    writeFileSync(join(root, "package.json"), "{}");
    const result = await checkLicenses(root, {
      resolveToolBin: async () => "scanner",
      execFileNoThrow: async () => ({
        ok: true,
        exitCode: 0,
        stderr: "npm WARN deprecated",
        stdout: '{"fixture@1.0.0":{"licenses":"GPL-3.0"}}',
      }),
    });
    assert.equal(result.status, "warn");
    assert.equal(result.severity, "medium");
    assert.equal(result.didNotRun, undefined);
    assert.match(result.detail, /fixture@1.0.0 \(GPL-3.0\)/);
  } finally {
    rmTemp(root);
  }
});

it("reports a real child process error after its warning and redacts its credential", async () => {
  const root = mkdtempSync(join(tmpdir(), "kit-license-process-"));
  try {
    writeFileSync(join(root, "package.json"), "{}");
    const scanner = join(root, "scanner.cjs");
    const token = `ghp_${"A".repeat(40)}`;
    writeFileSync(
      scanner,
      `console.error("npm WARN deprecated"); process.emit("error", new Error(${JSON.stringify(`EACCES: permission denied https://user:${token}@example.invalid`)}));`,
    );
    const result = await checkLicenses(root, {
      resolveToolBin: async () => process.execPath,
      execFileNoThrow: (bin, args, options) => execFileNoThrow(bin, [scanner, ...args], options),
    });
    assert.equal(result.didNotRun, true);
    assert.match(result.detail, /EACCES: permission denied/);
    assert.doesNotMatch(result.detail, /npm WARN|ghp_/);
  } finally {
    rmTemp(root);
  }
});
