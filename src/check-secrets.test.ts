import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkSecrets } from "./check-secrets.js";
import type { SecretsConfig } from "./config.js";

let tempDir: string;

before(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "kit-chksecrets-"));
});

after(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("checkSecrets - template", () => {
  it("returns templateExists null when no template path configured", async () => {
    const config: SecretsConfig = { store: "env" };
    const { templateExists } = await checkSecrets(config);
    assert.equal(templateExists, null);
  });

  it("returns templateExists true when template file exists", async () => {
    const templatePath = join(tempDir, ".env.template");
    await writeFile(templatePath, "API_KEY=\nDB_URL=\n", "utf-8");

    const config: SecretsConfig = { store: "env", template: templatePath };
    const { templateExists } = await checkSecrets(config);
    assert.equal(templateExists, true);
  });

  it("returns templateExists false when template file does not exist", async () => {
    const config: SecretsConfig = {
      store: "env",
      template: join(tempDir, "nonexistent.env"),
    };
    const { templateExists } = await checkSecrets(config);
    assert.equal(templateExists, false);
  });
});

describe("checkSecrets - env source", () => {
  it("returns available when env variable is set", async () => {
    process.env._KIT_TEST_VAR = "hello";
    try {
      const config: SecretsConfig = {
        store: "env",
        keys: { _KIT_TEST_VAR: { source: "env" } },
      };
      const { keys } = await checkSecrets(config);
      assert.equal(keys.length, 1);
      assert.equal(keys[0].name, "_KIT_TEST_VAR");
      assert.equal(keys[0].source, "env");
      assert.equal(keys[0].available, true);
      assert.ok(keys[0].detail.includes("environment"));
    } finally {
      delete process.env._KIT_TEST_VAR;
    }
  });

  it("returns not available when env variable is not set", async () => {
    delete process.env._KIT_MISSING_VAR;
    const config: SecretsConfig = {
      store: "env",
      keys: { _KIT_MISSING_VAR: { source: "env" } },
    };
    const { keys } = await checkSecrets(config);
    assert.equal(keys[0].available, false);
    assert.ok(keys[0].detail.includes("Not set"));
  });
});

describe("checkSecrets - config source", () => {
  it("always returns available for config source", async () => {
    const config: SecretsConfig = {
      store: "env",
      keys: {
        DERIVED_VAR: { source: "config", value: "computed-value" },
      },
    };
    const { keys } = await checkSecrets(config);
    assert.equal(keys[0].available, true);
    assert.ok(keys[0].detail.includes("config"));
  });
});

describe("checkSecrets - missing ref/name handling", () => {
  it("returns not available for 1password without ref", async () => {
    const config: SecretsConfig = {
      store: "1password",
      keys: { API_KEY: { source: "1password" } },
    };
    const { keys } = await checkSecrets(config);
    assert.equal(keys[0].available, false);
    assert.ok(keys[0].detail.includes("No 1Password ref"));
  });

  it("returns not available for bitwarden without name or ref", async () => {
    const config: SecretsConfig = {
      store: "env",
      keys: { DB_PASS: { source: "bitwarden" } },
    };
    const { keys } = await checkSecrets(config);
    assert.equal(keys[0].available, false);
    assert.ok(keys[0].detail.includes("No Bitwarden field"));
  });

  it("returns not available for doppler without name", async () => {
    const config: SecretsConfig = {
      store: "env",
      keys: { SECRET: { source: "doppler" } },
    };
    const { keys } = await checkSecrets(config);
    assert.equal(keys[0].available, false);
    assert.ok(keys[0].detail.includes("No Doppler secret name"));
  });

  it("returns not available for vault without path and field", async () => {
    const config: SecretsConfig = {
      store: "env",
      keys: { DB_PASS: { source: "vault" } },
    };
    const { keys } = await checkSecrets(config);
    assert.equal(keys[0].available, false);
    assert.ok(keys[0].detail.includes("vault_path"));
  });

  it("returns not available for azure-kv without vault name", async () => {
    const saved = process.env.AZURE_KEYVAULT_NAME;
    delete process.env.AZURE_KEYVAULT_NAME;
    try {
      const config: SecretsConfig = {
        store: "env",
        keys: { TOKEN: { source: "azure-kv" } },
      };
      const { keys } = await checkSecrets(config);
      assert.equal(keys[0].available, false);
      assert.ok(keys[0].detail.includes("azure_vault"));
    } finally {
      if (saved !== undefined) process.env.AZURE_KEYVAULT_NAME = saved;
    }
  });

  it("reports CLI-not-installed for aws-sm when aws binary missing", async () => {
    // The check shells to `aws`. In CI without the CLI installed, the call
    // fails with ENOENT — we expect a clear "not available" message rather
    // than a crash or "unknown source" fallthrough.
    const config: SecretsConfig = {
      store: "env",
      keys: { TOKEN: { source: "aws-sm", name: "nonexistent-secret-xyz" } },
    };
    const { keys } = await checkSecrets(config);
    assert.equal(keys[0].available, false);
    // Either CLI missing, secret not found, or auth failure — all acceptable.
    assert.ok(
      keys[0].detail.includes("AWS") || keys[0].detail.includes("aws"),
      `expected AWS-related detail, got: ${keys[0].detail}`,
    );
  });
});

describe("checkSecrets - multiple sources", () => {
  it("checks all keys and returns individual results", async () => {
    process.env._KIT_EXISTS = "yes";
    try {
      const config: SecretsConfig = {
        store: "env",
        keys: {
          _KIT_EXISTS: { source: "env" },
          _KIT_GONE: { source: "env" },
          CONFIG_VAL: { source: "config", value: "x" },
        },
      };
      const { keys } = await checkSecrets(config);
      assert.equal(keys.length, 3);

      const exists = keys.find((k) => k.name === "_KIT_EXISTS")!;
      const gone = keys.find((k) => k.name === "_KIT_GONE")!;
      const cfg = keys.find((k) => k.name === "CONFIG_VAL")!;

      assert.equal(exists.available, true);
      assert.equal(gone.available, false);
      assert.equal(cfg.available, true);
    } finally {
      delete process.env._KIT_EXISTS;
      delete process.env._KIT_GONE;
    }
  });

  it("returns empty keys array when no keys configured", async () => {
    const config: SecretsConfig = { store: "env" };
    const { keys } = await checkSecrets(config);
    assert.deepEqual(keys, []);
  });
});
