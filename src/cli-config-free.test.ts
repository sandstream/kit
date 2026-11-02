/**
 * Split out of cli.test.ts: the config-free and self-audit tests spawn the CLI and are among its slowest tests. Kept in one file,
 * cli.test.js ran serially for about a minute alone and timed out at 180 s under CI's parallel load.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCli } from "./cli-run.test-support.js";

// Regressions from running kit on third-party / vendor repos: `kit scan` must not
// require (or create) a .kit.toml, and `kit init --no-setup` must actually stop
// after config instead of running the full setup pipeline.
describe("vendor-repo safety: config-free scan + honored --no-setup", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "kit-cfgfree-"));
    await writeFile(join(dir, "package.json"), '{"name":"t","dependencies":{}}', "utf-8");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("kit scan runs without a .kit.toml and never creates one", async () => {
    const result = await runCli(["scan"], dir);
    // The regression: a missing config used to ENOENT into "Create a .kit.toml".
    // (Assertion is timeout-safe: that error fires at config-load, before scanners.)
    assert.ok(
      !result.stdout.includes("Create a .kit.toml") &&
        !result.stderr.includes("Create a .kit.toml"),
      `scan must not demand config; got: ${result.stdout}\n${result.stderr}`,
    );
    await assert.rejects(access(join(dir, ".kit.toml")), "scan must not write a .kit.toml");
  });

  it("kit init --no-setup generates config then stops (no install/login/secrets)", async () => {
    const result = await runCli(["init", "--no-setup", "--non-interactive"], dir);
    await access(join(dir, ".kit.toml")); // init's job: the config IS created
    assert.ok(
      /Setup skipped/.test(result.stdout),
      `expected 'Setup skipped'; got: ${result.stdout}`,
    );
  });

  // Project-agnostic commands must not require (or create) a .kit.toml either.
  for (const args of [["supply-chain"], ["sentinel", "status"], ["verify-provenance"]]) {
    it(`kit ${args.join(" ")} runs without a .kit.toml`, async () => {
      const result = await runCli(args, dir);
      assert.ok(
        !result.stdout.includes("Create a .kit.toml") &&
          !result.stderr.includes("Create a .kit.toml"),
        `${args[0]} must not demand config; got: ${result.stdout}\n${result.stderr}`,
      );
      await assert.rejects(access(join(dir, ".kit.toml")), `${args[0]} must not write a .kit.toml`);
    });
  }
});

describe("kit self-audit (clean tree, machine output)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "kit-selfaudit-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("--json: ok=true, failed=0, advisories separate from warnings, files carried", async () => {
    const result = await runCli(["self-audit", "--json"], dir);
    assert.equal(result.exitCode, 0, `expected exit 0; stderr: ${result.stderr}`);
    const out = JSON.parse(result.stdout) as {
      ok: boolean;
      checks: { status: string; category: string; files?: string[]; severity?: string }[];
      summary: { failed: number; warnings: number; advisories?: number };
    };
    assert.equal(out.ok, true);
    assert.equal(out.summary.failed, 0);
    // Advisories (R5/R10 info) are tallied apart from warnings.
    assert.ok((out.summary.advisories ?? 0) > 0, "expected aggregated advisories on kit's tree");
    // Every non-pass check carries a files path:line (advisory rows are aggregated
    // and carry only a category, so restrict to gating fail/warn rows).
    const gating = out.checks.filter(
      (ch) => (ch.status === "fail" || ch.status === "warn") && ch.severity !== "low",
    );
    for (const ch of gating) {
      assert.ok(
        ch.files && ch.files.length > 0 && /:\d+$/.test(ch.files[0]),
        `non-pass check ${ch.category} must carry a file:line; got ${JSON.stringify(ch.files)}`,
      );
    }
  });

  it("--fail-on-warning exits 0 on the clean tree (advisories never gate)", async () => {
    const result = await runCli(["self-audit", "--fail-on-warning"], dir);
    assert.equal(
      result.exitCode,
      0,
      `--fail-on-warning must pass on kit's clean tree; stdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  });
});
