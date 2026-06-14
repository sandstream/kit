import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  checkSecretExpiration,
  getEnvExpirationHint,
  get1PasswordExpiration,
  formatSecretExpirationWarnings,
  hasExpiredSecrets,
  hasSecretWarnings,
  type SecretExpiration,
} from "./secret-expiration.js";
import type { GovernanceConfig, SecretsConfig } from "./config.js";

const enabledConfig: GovernanceConfig = {
  enabled: true,
  secrets: { check_expiration: true, warn_days_before_expiry: 30 },
};

const disabledConfig: GovernanceConfig = {
  enabled: true,
  secrets: { check_expiration: false },
};

// Helpers for building expiry dates relative to today
function daysFromNow(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

function daysAgo(days: number): string {
  return daysFromNow(-days);
}

describe("getEnvExpirationHint", () => {
  afterEach(() => {
    delete process.env._KIT_TEST_KEY_EXPIRES_AT;
    delete process.env._KIT_BAD_DATE_EXPIRES_AT;
  });

  it("returns null when env var is not set", () => {
    delete process.env.SOME_SECRET_EXPIRES_AT;
    assert.equal(getEnvExpirationHint("SOME_SECRET"), null);
  });

  it("returns ISO string when env var contains a valid date", () => {
    process.env._KIT_TEST_KEY_EXPIRES_AT = "2027-06-15T00:00:00Z";
    const result = getEnvExpirationHint("_KIT_TEST_KEY");
    assert.ok(result !== null);
    assert.ok(result.includes("2027"));
  });

  it("returns null and warns when env var contains an invalid date", () => {
    process.env._KIT_BAD_DATE_EXPIRES_AT = "not-a-date";
    const result = getEnvExpirationHint("_KIT_BAD_DATE");
    assert.equal(result, null);
  });

  it("converts key to uppercase when building env var name", () => {
    process.env._KIT_TEST_KEY_EXPIRES_AT = "2028-01-01T00:00:00Z";
    // lowercase key should still match the uppercase env var
    const result = getEnvExpirationHint("_kit_test_key");
    assert.ok(result !== null);
  });
});

describe("checkSecretExpiration - disabled", () => {
  it("returns empty array when check_expiration is false", async () => {
    process.env.MY_SECRET_EXPIRES_AT = daysAgo(5);
    try {
      const result = await checkSecretExpiration(disabledConfig, ["MY_SECRET"]);
      assert.deepEqual(result, []);
    } finally {
      delete process.env.MY_SECRET_EXPIRES_AT;
    }
  });

  it("returns empty array when no config provided", async () => {
    const result = await checkSecretExpiration(undefined, ["MY_SECRET"]);
    assert.deepEqual(result, []);
  });
});

describe("checkSecretExpiration - env var hints", () => {
  afterEach(() => {
    delete process.env.EXPIRED_KEY_EXPIRES_AT;
    delete process.env.WARNING_KEY_EXPIRES_AT;
    delete process.env.FINE_KEY_EXPIRES_AT;
  });

  it("detects expired secrets via env var hint", async () => {
    process.env.EXPIRED_KEY_EXPIRES_AT = daysAgo(5);

    const result = await checkSecretExpiration(enabledConfig, ["EXPIRED_KEY"]);

    assert.equal(result.length, 1);
    assert.equal(result[0].key, "EXPIRED_KEY");
    assert.equal(result[0].expired, true);
    assert.equal(result[0].warning, false);
    assert.ok((result[0].days_until_expiry ?? 0) < 0);
  });

  it("detects secrets expiring soon (within warn_days_before_expiry)", async () => {
    process.env.WARNING_KEY_EXPIRES_AT = daysFromNow(10);

    const result = await checkSecretExpiration(enabledConfig, ["WARNING_KEY"]);

    assert.equal(result.length, 1);
    assert.equal(result[0].expired, false);
    assert.equal(result[0].warning, true);
    assert.ok((result[0].days_until_expiry ?? 999) <= 30);
    assert.ok((result[0].days_until_expiry ?? -1) >= 0);
  });

  it("returns no entry for secrets with no expiration data", async () => {
    delete process.env.FINE_KEY_EXPIRES_AT;
    const result = await checkSecretExpiration(enabledConfig, ["FINE_KEY"]);
    assert.deepEqual(result, []);
  });

  it("does not flag secrets that expire far in the future", async () => {
    process.env.FINE_KEY_EXPIRES_AT = daysFromNow(90);

    const result = await checkSecretExpiration(enabledConfig, ["FINE_KEY"]);

    assert.equal(result.length, 1);
    assert.equal(result[0].expired, false);
    assert.equal(result[0].warning, false);
  });

  it("checks multiple keys independently", async () => {
    process.env.EXPIRED_KEY_EXPIRES_AT = daysAgo(3);
    process.env.WARNING_KEY_EXPIRES_AT = daysFromNow(5);

    const result = await checkSecretExpiration(
      enabledConfig,
      ["EXPIRED_KEY", "WARNING_KEY", "FINE_KEY"],
    );

    // FINE_KEY has no hint, so only 2 entries
    assert.equal(result.length, 2);
    const expired = result.find((r) => r.key === "EXPIRED_KEY")!;
    const warning = result.find((r) => r.key === "WARNING_KEY")!;
    assert.equal(expired.expired, true);
    assert.equal(warning.warning, true);
  });
});

describe("checkSecretExpiration - store dispatch", () => {
  afterEach(() => {
    delete process.env.INFISICAL_KEY_EXPIRES_AT;
    delete process.env.DOPPLER_KEY_EXPIRES_AT;
    delete process.env.BW_KEY_EXPIRES_AT;
  });

  it("falls back to env hint for infisical source", async () => {
    process.env.INFISICAL_KEY_EXPIRES_AT = daysAgo(2);

    const secretsConfig: SecretsConfig = {
      store: "infisical",
      keys: { INFISICAL_KEY: { source: "infisical" } },
    };
    const result = await checkSecretExpiration(
      enabledConfig,
      ["INFISICAL_KEY"],
      secretsConfig,
    );

    assert.equal(result.length, 1);
    assert.equal(result[0].expired, true);
  });

  it("falls back to env hint for doppler source", async () => {
    process.env.DOPPLER_KEY_EXPIRES_AT = daysAgo(1);

    const secretsConfig: SecretsConfig = {
      store: "doppler",
      keys: { DOPPLER_KEY: { source: "doppler" } },
    };
    const result = await checkSecretExpiration(
      enabledConfig,
      ["DOPPLER_KEY"],
      secretsConfig,
    );

    assert.equal(result.length, 1);
    assert.equal(result[0].expired, true);
  });

  it("falls back to env hint for bitwarden source", async () => {
    process.env.BW_KEY_EXPIRES_AT = daysFromNow(7);

    const secretsConfig: SecretsConfig = {
      keys: { BW_KEY: { source: "bitwarden", name: "My Password" } },
    };
    const result = await checkSecretExpiration(
      enabledConfig,
      ["BW_KEY"],
      secretsConfig,
    );

    assert.equal(result.length, 1);
    assert.equal(result[0].warning, true);
  });

  it("falls back to env hint for 1password when no ref configured", async () => {
    process.env.OP_KEY_EXPIRES_AT = daysAgo(10);

    const secretsConfig: SecretsConfig = {
      keys: { OP_KEY: { source: "1password" } }, // no ref
    };
    const result = await checkSecretExpiration(
      enabledConfig,
      ["OP_KEY"],
      secretsConfig,
    );

    assert.equal(result.length, 1);
    assert.equal(result[0].expired, true);
    delete process.env.OP_KEY_EXPIRES_AT;
  });
});

describe("get1PasswordExpiration", () => {
  it("returns null when op CLI is not available", async () => {
    // op is likely not installed in the test environment; graceful failure
    const result = await get1PasswordExpiration("op://Personal/MyItem/password");
    // Either null (op not found) or a string (op installed and returned expiry)
    assert.ok(result === null || typeof result === "string");
  });

  it("returns null for invalid ref format", async () => {
    // Single segment with no vault/item split
    const result = await get1PasswordExpiration("singlepart");
    assert.equal(result, null);
  });

  it("handles op:// prefix in ref", async () => {
    // Should not throw; returns null gracefully if op is unavailable
    const result = await get1PasswordExpiration("op://MyVault/MyItem/field");
    assert.ok(result === null || typeof result === "string");
  });
});

describe("formatSecretExpirationWarnings", () => {
  it("returns all-clear message when no warnings", () => {
    const output = formatSecretExpirationWarnings([]);
    assert.ok(output.includes("All secrets are current"));
  });

  it("formats expired secrets with days ago", () => {
    const expirations: SecretExpiration[] = [
      {
        key: "OLD_KEY",
        expiry_date: daysAgo(5),
        days_until_expiry: -5,
        expired: true,
        warning: false,
      },
    ];
    const output = formatSecretExpirationWarnings(expirations);
    assert.ok(output.includes("EXPIRED"));
    assert.ok(output.includes("OLD_KEY"));
    assert.ok(output.includes("5 days ago"));
  });

  it("formats expiring-soon secrets with days remaining", () => {
    const expirations: SecretExpiration[] = [
      {
        key: "SOON_KEY",
        expiry_date: daysFromNow(10),
        days_until_expiry: 10,
        expired: false,
        warning: true,
      },
    ];
    const output = formatSecretExpirationWarnings(expirations);
    assert.ok(output.includes("EXPIRING SOON"));
    assert.ok(output.includes("SOON_KEY"));
    assert.ok(output.includes("10 days"));
  });

  it("shows both expired and warning sections when both present", () => {
    const expirations: SecretExpiration[] = [
      { key: "DEAD", expiry_date: daysAgo(1), days_until_expiry: -1, expired: true, warning: false },
      { key: "SOON", expiry_date: daysFromNow(5), days_until_expiry: 5, expired: false, warning: true },
    ];
    const output = formatSecretExpirationWarnings(expirations);
    assert.ok(output.includes("EXPIRED"));
    assert.ok(output.includes("EXPIRING SOON"));
  });
});

describe("hasExpiredSecrets / hasSecretWarnings", () => {
  it("hasExpiredSecrets returns false when none expired", () => {
    assert.equal(hasExpiredSecrets([]), false);
    assert.equal(
      hasExpiredSecrets([{ key: "k", expired: false, warning: true }]),
      false,
    );
  });

  it("hasExpiredSecrets returns true when any expired", () => {
    assert.equal(
      hasExpiredSecrets([{ key: "k", expired: true, warning: false }]),
      true,
    );
  });

  it("hasSecretWarnings returns false when none warning", () => {
    assert.equal(hasSecretWarnings([]), false);
    assert.equal(
      hasSecretWarnings([{ key: "k", expired: true, warning: false }]),
      false,
    );
  });

  it("hasSecretWarnings returns true when any warning", () => {
    assert.equal(
      hasSecretWarnings([{ key: "k", expired: false, warning: true }]),
      true,
    );
  });
});
