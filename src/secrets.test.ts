import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateSecrets } from "./secrets.js";
import type { SecretsConfig } from "./config.js";

const tmpOut = join(tmpdir(), `.kit-test-${process.pid}.env`);

afterEach(async () => {
  try { await unlink(tmpOut); } catch { /* ignore */ }
});

describe("generateSecrets", () => {
  it("returns early when no keys configured", async () => {
    const config: SecretsConfig = { store: "env" };
    const { results, written } = await generateSecrets(config, tmpOut);
    assert.equal(results.length, 0);
    assert.equal(written, false);
  });

  it("resolves env secrets from process.env", async () => {
    process.env._KIT_TEST_SECRET = "hello123";
    try {
      const config: SecretsConfig = {
        keys: {
          _KIT_TEST_SECRET: { source: "env" },
        },
      };
      const { results, written } = await generateSecrets(config, tmpOut);
      assert.equal(results.length, 1);
      assert.equal(results[0].resolved, true);
      assert.equal(results[0].value, "hello123");
      assert.equal(results[0].detail, "From environment");
      assert.equal(written, true);

      const content = await readFile(tmpOut, "utf-8");
      assert.ok(content.includes("_KIT_TEST_SECRET=hello123"));
    } finally {
      delete process.env._KIT_TEST_SECRET;
    }
  });

  it("marks missing env secrets as unresolved", async () => {
    delete process.env._KIT_MISSING;
    const config: SecretsConfig = {
      keys: {
        _KIT_MISSING: { source: "env" },
      },
    };
    const { results } = await generateSecrets(config, tmpOut);
    assert.equal(results[0].resolved, false);
    assert.equal(results[0].detail, "Not set in environment");
  });

  it("resolves config secrets from value field", async () => {
    const config: SecretsConfig = {
      keys: {
        APP_MODE: { source: "config", value: "production" },
      },
    };
    const { results } = await generateSecrets(config, tmpOut);
    assert.equal(results[0].resolved, true);
    assert.equal(results[0].value, "production");
    assert.equal(results[0].detail, "From config");
  });

  it("marks config secrets without value as unresolved", async () => {
    const config: SecretsConfig = {
      keys: {
        APP_MODE: { source: "config" },
      },
    };
    const { results } = await generateSecrets(config, tmpOut);
    assert.equal(results[0].resolved, false);
  });

  it("generates key-based output without template", async () => {
    process.env._KIT_A = "val_a";
    try {
      const config: SecretsConfig = {
        keys: {
          _KIT_A: { source: "env" },
          MISSING_B: { source: "env" },
          STATIC_C: { source: "config", value: "static" },
        },
      };
      const { results, fromTemplate } = await generateSecrets(config, tmpOut);
      assert.equal(fromTemplate, false);
      assert.equal(results.length, 3);

      const content = await readFile(tmpOut, "utf-8");
      assert.ok(content.includes("_KIT_A=val_a"));
      assert.ok(content.includes("# MISSING_B="));
      assert.ok(content.includes("STATIC_C=static"));
    } finally {
      delete process.env._KIT_A;
    }
  });

  it("handles infisical source gracefully when CLI unavailable", async () => {
    const config: SecretsConfig = {
      keys: {
        DB_URL: { source: "infisical" },
      },
      infisical: { environment: "test" },
    };
    const { results } = await generateSecrets(config, tmpOut);
    assert.equal(results[0].resolved, false);
    assert.equal(results[0].detail, "Not found in Infisical");
  });

  it("reports unknown source", async () => {
    const config: SecretsConfig = {
      keys: {
        X: { source: "bogus" as any },
      },
    };
    const { results } = await generateSecrets(config, tmpOut);
    assert.equal(results[0].resolved, false);
    assert.ok(results[0].detail.includes("Unknown source"));
  });

  it("does not clobber an existing .env.local when nothing resolved", async () => {
    const original = "NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54521\nKEEP=me\n";
    await writeFile(tmpOut, original, "utf-8");
    delete process.env._KIT_NONE;
    const config: SecretsConfig = { keys: { _KIT_NONE: { source: "env" } } };

    const { written, skipped } = await generateSecrets(config, tmpOut);

    assert.equal(written, false);
    assert.equal(skipped, "nothing-resolved");
    const after = await readFile(tmpOut, "utf-8");
    assert.equal(after, original, "existing file must be left untouched");
  });

  it("writes a scaffold when nothing resolved and no file exists yet", async () => {
    try { await unlink(tmpOut); } catch { /* ignore */ }
    delete process.env._KIT_NONE2;
    const config: SecretsConfig = { keys: { _KIT_NONE2: { source: "env" } } };

    const { written, skipped } = await generateSecrets(config, tmpOut);

    assert.equal(written, true);
    assert.equal(skipped, undefined);
  });
});
