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

const LGPL_REPORT = JSON.stringify({
  "@img/sharp-libvips-darwin-arm64@1.3.4": { licenses: "LGPL-3.0-or-later" },
  "left-pad@1.3.0": { licenses: "MIT" },
});

async function licenseResult(kitToml: string | null, report = LGPL_REPORT) {
  const root = mkdtempSync(join(tmpdir(), "kit-license-allow-"));
  try {
    writeFileSync(join(root, "package.json"), "{}");
    if (kitToml !== null) writeFileSync(join(root, ".kit.toml"), kitToml);
    return await checkLicenses(root, {
      resolveToolBin: async () => "scanner",
      execFileNoThrow: async () => ({ ok: true, exitCode: 0, stderr: "", stdout: report }),
    });
  } finally {
    rmTemp(root);
  }
}

it("accepts a copyleft package that the repo allowlists with a reason", async () => {
  const result = await licenseResult(
    '[licenses.allow]\n"@img/sharp-libvips-*" = { license = "LGPL-3.0-or-later", reason = "dynamically linked optional binary of sharp" }\n',
  );
  assert.equal(result.status, "pass");
  assert.match(result.detail, /1 accepted/);
  assert.match(result.detail, /@img\/sharp-libvips-darwin-arm64@1\.3\.4/);
});

it("still warns when the allowlisted package reports a different license", async () => {
  const result = await licenseResult(
    '[licenses.allow]\n"@img/sharp-libvips-*" = { license = "LGPL-2.1", reason = "dynamically linked" }\n',
  );
  assert.equal(result.status, "warn");
  assert.match(result.detail, /1 copyleft license/);
});

it("rejects an allowlist entry without a reason and keeps the warning", async () => {
  const result = await licenseResult(
    '[licenses.allow]\n"@img/sharp-libvips-*" = { license = "LGPL-3.0-or-later" }\n',
  );
  assert.equal(result.status, "warn");
  assert.match(result.detail, /no reason/);
  assert.match(result.detail, /@img\/sharp-libvips-\*/);
});

it("matches an exact package name without a wildcard, and not a longer name", async () => {
  const exact = await licenseResult(
    '[licenses.allow]\n"@img/sharp-libvips-darwin-arm64" = { license = "LGPL-3.0-or-later", reason = "dynamic" }\n',
  );
  assert.equal(exact.status, "pass");
  const prefixOnly = await licenseResult(
    '[licenses.allow]\n"@img/sharp-libvips" = { license = "LGPL-3.0-or-later", reason = "dynamic" }\n',
  );
  assert.equal(prefixOnly.status, "warn");
});

it("keeps today's verdict when the repo has no .kit.toml", async () => {
  const result = await licenseResult(null);
  assert.equal(result.status, "warn");
});
