import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  runCheckGate,
  checkRunToJsonChecks,
  parseCategoryFlag,
  isCheckCategory,
  CHECK_CATEGORIES,
  type CheckRunResult,
} from "./check-run.js";

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
      "deploy",
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
        deploy: true,
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
    deploy: [
      {
        provider: "vercel",
        environment: "production",
        project: "app-prod",
        status: "warn",
        detail: "drift: remote key name(s) present in another deploy target but missing here: KEY",
        drift: ["KEY"],
      },
    ],
    security: [{ category: "secrets", name: "gitleaks", status: "pass", detail: "clean" }],
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
    assert.equal(byName["vercel/production/app-prod"].status, "warn");
    // webSearch: null contributes no row.
    assert.equal(rows.length, 10);
  });
});

// --category narrowing. Before 6.2.0 the flag was documented in kit's own generated
// CLAUDE.md, in example pre-commit hooks and in a CI workflow, and nothing parsed it
// — the full check ran every time. These pin both halves: it really narrows, and a
// narrowed run is marked so a partial green cannot read as a full one.
describe("runCheckGate — category narrowing", () => {
  let tempDir: string;
  let originalCwd: string;

  before(async () => {
    originalCwd = process.cwd();
    tempDir = await mkdtemp(join(tmpdir(), "kit-cat-"));
    await writeFile(
      join(tempDir, ".kit.toml"),
      '[tools]\nnode = "22"\n\n[services.demo]\nlogin = "true"\ncheck = "true"\n',
      "utf-8",
    );
    process.chdir(tempDir);
  });

  after(async () => {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  });

  it("a full run has scope null — the default cannot be narrowed by accident", async () => {
    const run = await runCheckGate({ cwd: tempDir });
    assert.equal(run.scope, null);
  });

  it("an empty category list is treated as a full run, not as nothing", async () => {
    const run = await runCheckGate({ cwd: tempDir, categories: [] });
    assert.equal(run.scope, null);
  });

  it("narrowing to tools runs tools and leaves the other dimensions empty", async () => {
    const run = await runCheckGate({ cwd: tempDir, categories: ["tools"] });
    assert.deepEqual(run.scope, ["tools"]);
    assert.ok(run.tools.length > 0, "tools must still run");
    assert.deepEqual(run.services, [], "services must not run");
    assert.deepEqual(run.security, [], "security must not run");
    assert.deepEqual(run.locks, [], "locks must not run");
    assert.deepEqual(run.tests, [], "tests must not run");
    assert.deepEqual(run.deploy, [], "deploy must not run");
  });

  it("omitted dimensions are absent from the flattened rows, never synthesised as passes", async () => {
    const run = await runCheckGate({ cwd: tempDir, categories: ["tools"] });
    const rows = checkRunToJsonChecks(run);
    assert.ok(rows.length > 0);
    assert.equal(
      rows.some((r) => r.category === "security"),
      false,
      "a dimension that did not run must not appear as a row",
    );
  });

  it("accepts several categories at once", async () => {
    const run = await runCheckGate({ cwd: tempDir, categories: ["tools", "services"] });
    assert.deepEqual(run.scope, ["tools", "services"]);
    assert.ok(run.tools.length > 0);
    assert.ok(run.services.length > 0);
    assert.deepEqual(run.security, []);
    assert.deepEqual(run.deploy, []);
  });
});

describe("parseCategoryFlag (pure)", () => {
  it("an absent flag means a full run", () => {
    assert.deepEqual(parseCategoryFlag(undefined), { categories: undefined });
  });

  it("parses a single category", () => {
    assert.deepEqual(parseCategoryFlag("security"), { categories: ["security"] });
  });

  it("parses a comma-separated list and trims", () => {
    assert.deepEqual(parseCategoryFlag("tools, security"), { categories: ["tools", "security"] });
  });

  it("reports an unknown value instead of falling back to a full run", () => {
    // The whole defect this flag had: an unrecognised value must not silently run
    // everything.
    assert.deepEqual(parseCategoryFlag("nonsense"), { invalid: ["nonsense"] });
  });

  it("reports every unknown value in a mixed list", () => {
    assert.deepEqual(parseCategoryFlag("security,bogus,alsobogus"), {
      invalid: ["bogus", "alsobogus"],
    });
  });

  it("treats an empty or comma-only value as invalid, not as a full run", () => {
    assert.deepEqual(parseCategoryFlag(""), { invalid: ["(empty)"] });
    assert.deepEqual(parseCategoryFlag(",, "), { invalid: ["(empty)"] });
  });

  it("every advertised category is accepted by the parser", () => {
    for (const cat of CHECK_CATEGORIES) {
      assert.deepEqual(parseCategoryFlag(cat), { categories: [cat] });
      assert.equal(isCheckCategory(cat), true);
    }
  });
});
