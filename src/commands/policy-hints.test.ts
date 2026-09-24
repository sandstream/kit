import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";

it("policy pull refusals name the real trust command", () => {
  const root = mkdtempSync(join(tmpdir(), "kit-policy-hint-"));
  const source = join(root, "source");
  const dest = join(root, "dest");
  mkdirSync(source);
  mkdirSync(dest);
  writeFileSync(join(source, ".kit-policy.toml"), "version = 1\n");
  writeFileSync(join(source, ".kit-policy.sig"), "{}\n");
  writeFileSync(join(source, "revocations.jsonl"), "\n");
  const sourceTest = import.meta.url.endsWith(".ts");
  const cli = fileURLToPath(new URL(sourceTest ? "../cli.ts" : "../cli.js", import.meta.url));
  try {
    for (const verb of ["pull", "pull-revocations"]) {
      const run = spawnSync(
        process.execPath,
        [
          ...(sourceTest ? ["--import", import.meta.resolve("tsx")] : []),
          cli,
          "policy",
          verb,
          source,
        ],
        { cwd: dest, encoding: "utf8", env: { ...process.env, KIT_NO_UPDATE_CHECK: "1" } },
      );
      assert.equal(run.status, 1, run.stderr);
      assert.match(run.stderr, /kit policy trust <pubkey\.pem>/);
      assert.doesNotMatch(run.stderr, /kit policy trust add/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
