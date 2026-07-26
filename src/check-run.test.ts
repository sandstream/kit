import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCheckGate, checkRunToJsonChecks, type CheckRunResult } from "./check-run.js";

// runCheckGate is the collection core `kit check`, the MCP `kit_check` tool, and
// `kit review`'s check stage all share; checkRunToJsonChecks is the one flattening
// to machine-readable rows. These tests pin the shapes both contracts rest on.

describe("runCheckGate", () => {
  let tempDir: string;
  let originalCwd: string;
  let result: CheckRunResult;

  before(async () => {
    // The security/test-coverage scanners walk process.cwd() — chdir into an
    // isolated fixture so the run is about the fixture and stays fast.
    originalCwd = process.cwd();
    tempDir = await mkdtemp(join(tmpdir(), "kit-check-run-"));
    await writeFile(join(tempDir, ".gitignore"), ".env\n.env.local\n.env.*.local\n", "utf-8");
    await writeFile(
      join(tempDir, ".kit.toml"),
      `[secrets.keys]\nAPP_KEY = { source = "config", value = "hello" }\n`,
      "utf-8",
    );
    process.chdir(tempDir);
    result = await runCheckGate({ cwd: tempDir });
  });

  after(async () => {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns the verdict and every dimension's raw results", () => {
    assert.equal(typeof result.ok, "boolean");
    assert.equal(result.ok, result.verdict.ok);
    for (const key of [
      "tools",
      "services",
      "skills",
      "hooks",
      "security",
      "tests",
      "locks",
    ] as const) {
      assert.ok(Array.isArray(result[key]), `${key} missing`);
    }
    assert.ok("keys" in result.secrets);
  });

  it("resolves the configured secret exactly like kit check does", () => {
    assert.equal(result.secrets.keys[0]?.name, "APP_KEY");
    assert.equal(result.secrets.keys[0]?.available, true);
    assert.equal(result.verdict.dimensions.secrets, true);
  });
});

describe("checkRunToJsonChecks", () => {
  const base: CheckRunResult = {
    ok: false,
    verdict: {
      ok: false,
      dimensions: {
        tools: true,
        services: false,
        secrets: true,
        skills: true,
        hooks: false,
        security: true,
        tests: true,
        locks: true,
      },
      failed: ["services", "hooks"],
    },
    tools: [{ name: "node", ok: true, installed: "v22" }],
    services: [
      { name: "gh", authenticated: false, informational: true, output: "manual setup" },
      { name: "vercel", authenticated: false },
    ],
    secrets: { templateExists: true, keys: [{ name: "KEY", available: false }] },
    skills: [{ name: "triage", required: false, installed: false }],
    hooks: [{ hookName: "pre-commit", installed: true, upToDate: false, detail: "outdated" }],
    webSearch: null,
    security: [
      { category: "secrets", name: "gitleaks", status: "pass", detail: "clean" },
    ],
    tests: [{ name: "unit-test coverage", status: "warn", detail: "1 untested" }],
    locks: [{ category: "skills-lock", exists: true, inSync: true, detail: "in sync" }],
  } as CheckRunResult;

  it("maps every dimension to rows with the CLI's exact status rules", () => {
    const rows = checkRunToJsonChecks(base);
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
    assert.equal(byName["node"].status, "pass");
    // Informational service (manual setup) warns; a plain unauthenticated one fails.
    assert.equal(byName["gh"].status, "warn");
    assert.equal(byName["vercel"].status, "fail");
    assert.equal(byName["KEY"].status, "fail");
    // Optional skill missing warns (only required ones fail).
    assert.equal(byName["triage"].status, "warn");
    // Installed-but-outdated hook is a warn row even though the verdict dimension is red.
    assert.equal(byName["pre-commit"].status, "warn");
    assert.equal(byName["gitleaks"].category, "security/secrets");
    assert.equal(byName["skills-lock.json"].status, "pass");
    // webSearch: null contributes no row.
    assert.equal(rows.length, 9);
  });
});
