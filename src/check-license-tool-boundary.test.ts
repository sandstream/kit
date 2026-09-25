import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkLicenses } from "./check-security.js";

it("uses JSON scan even when --version would fail", async () => {
  const root = mkdtempSync(join(tmpdir(), "kit-license-version-"));
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x", version: "1.0.0" }));
    const calls: string[][] = [];
    const result = await checkLicenses(root, {
      resolveToolBin: async (name) => {
        assert.equal(name, "license-checker");
        return "synthetic-license-checker";
      },
      execFileNoThrow: async (bin, args, options) => {
        assert.equal(bin, "synthetic-license-checker");
        assert.equal(options?.cwd, root);
        calls.push(args);
        if (args.includes("--version"))
          return { ok: false, stdout: "25.0.1", stderr: "", exitCode: 1 };
        return {
          ok: true,
          stdout: '{"x@1.0.0":{"licenses":"MIT"}}',
          stderr: "",
          exitCode: 0,
        };
      },
    });
    assert.deepEqual(calls, [["--json", "--production"]]);
    assert.equal(result.status, "pass", result.detail);
    assert.equal(result.didNotRun, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
