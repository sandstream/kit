import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateSecrets, summarizeValidation } from "./secrets-validate.js";
import type { kitConfig, SecretKeyConfig } from "./config.js";

function configFor(keys: Record<string, SecretKeyConfig>): kitConfig {
  return {
    secrets: {
      store: "infisical",
      template: ".env.template",
      keys,
    },
  };
}

describe("validateSecrets", () => {
  it("marks present when checkAvailability returns true", async () => {
    const cfg = configFor({
      API_KEY: { source: "env" },
    });
    process.env.API_KEY = "x";
    try {
      const results = await validateSecrets(cfg, {});
      assert.equal(results[0]!.status, "present");
    } finally {
      delete process.env.API_KEY;
    }
  });

  it("marks missing when value cannot be resolved + no fix flag", async () => {
    const cfg = configFor({
      MISSING_KEY: { source: "env" },
    });
    delete process.env.MISSING_KEY;
    const results = await validateSecrets(cfg, {});
    assert.equal(results[0]!.status, "missing");
  });

  it("--auto uses .env.template values when available", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-validate-"));
    try {
      writeFileSync(join(dir, ".env.template"), "MISSING_KEY=template-value\n");
      const cfg = configFor({
        MISSING_KEY: { source: "infisical", name: "MISSING_KEY" },
      });
      const results = await validateSecrets(cfg, { auto: true, cwd: dir }, async () => false);
      // Will attempt to write to infisical — that fails in unit tests because
      // the CLI isn't installed/auth'd. Status will be "unfixable" with the
      // backend-error detail, NOT "no value in template" — that path is what
      // we're testing here.
      const r = results[0]!;
      assert.ok(
        r.status === "fixed" || r.status === "unfixable",
        `expected fixed/unfixable, got ${r.status}`,
      );
      // If unfixable, ensure it's NOT because the value was missing.
      if (r.status === "unfixable") {
        assert.ok(!r.detail.includes("no value in"), `detail=${r.detail}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--auto with empty template entry → unfixable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-validate-"));
    try {
      writeFileSync(join(dir, ".env.template"), "MISSING_KEY=\n");
      const cfg = configFor({
        MISSING_KEY: { source: "infisical", name: "MISSING_KEY" },
      });
      const results = await validateSecrets(cfg, { auto: true, cwd: dir }, async () => false);
      assert.equal(results[0]!.status, "unfixable");
      assert.match(results[0]!.detail, /no value in/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--fix with prompt that returns null → unfixable", async () => {
    const cfg = configFor({
      MISSING_KEY: { source: "infisical", name: "MISSING_KEY" },
    });
    const results = await validateSecrets(
      cfg,
      { fix: true, prompt: async () => null },
      async () => false,
    );
    assert.equal(results[0]!.status, "unfixable");
  });
});

describe("summarizeValidation", () => {
  it("counts statuses correctly", () => {
    const summary = summarizeValidation([
      { key: "A", source: "env", status: "present", detail: "" },
      { key: "B", source: "env", status: "missing", detail: "" },
      { key: "C", source: "env", status: "fixed", detail: "" },
      { key: "D", source: "env", status: "unfixable", detail: "" },
    ]);
    assert.equal(summary.total, 4);
    assert.equal(summary.present, 1);
    assert.equal(summary.missing, 1);
    assert.equal(summary.fixed, 1);
    assert.equal(summary.unfixable, 1);
    assert.equal(summary.ok, false);
  });

  it("ok=true when no missing + no unfixable", () => {
    const summary = summarizeValidation([
      { key: "A", source: "env", status: "present", detail: "" },
      { key: "B", source: "env", status: "fixed", detail: "" },
    ]);
    assert.equal(summary.ok, true);
  });
});
