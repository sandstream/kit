import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { detectEnvironment, isOperationAllowed, formatEnvironment } from "./environment.js";
import type { GovernanceConfig } from "./config.js";

describe("detectEnvironment", () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.NODE_ENV = originalEnv;
    } else {
      delete process.env.NODE_ENV;
    }
  });

  it("detects production from NODE_ENV", () => {
    process.env.NODE_ENV = "production";
    const result = detectEnvironment();
    assert.equal(result.environment, "prod");
    assert.equal(result.source, "env");
  });

  it("detects staging from NODE_ENV", () => {
    process.env.NODE_ENV = "staging";
    const result = detectEnvironment();
    assert.equal(result.environment, "staging");
    assert.equal(result.source, "env");
  });

  it("detects dev from NODE_ENV=development", () => {
    process.env.NODE_ENV = "development";
    const result = detectEnvironment();
    assert.equal(result.environment, "dev");
    assert.equal(result.source, "env");
  });

  it("detects dev from NODE_ENV=dev", () => {
    process.env.NODE_ENV = "dev";
    const result = detectEnvironment();
    assert.equal(result.environment, "dev");
    assert.equal(result.source, "env");
  });

  it("detects environment from git branch when NODE_ENV not set", () => {
    delete process.env.NODE_ENV;
    const result = detectEnvironment();
    // We're in a git repo, so should detect from branch
    assert.ok(["dev", "staging", "prod"].includes(result.environment));
    assert.ok(["git", "default"].includes(result.source));
  });

  it("includes access config when governance provided", () => {
    process.env.NODE_ENV = "production";
    const governance: GovernanceConfig = {
      enabled: true,
      access: {
        prod: { read: true, write: false, delete: false },
      },
    };
    const result = detectEnvironment(governance);
    assert.equal(result.environment, "prod");
    assert.ok(result.access);
    assert.equal(result.access.read, true);
    assert.equal(result.access.write, false);
    assert.equal(result.access.delete, false);
  });

  it("handles missing access config for environment", () => {
    process.env.NODE_ENV = "staging";
    const governance: GovernanceConfig = {
      enabled: true,
      access: {
        prod: { read: true, write: false, delete: false },
        // staging not configured
      },
    };
    const result = detectEnvironment(governance);
    assert.equal(result.environment, "staging");
    assert.equal(result.access, undefined);
  });
});

describe("isOperationAllowed", () => {
  it("allows all operations when no access config", () => {
    const envInfo = {
      environment: "prod" as const,
      source: "env" as const,
    };
    assert.equal(isOperationAllowed("read", envInfo), true);
    assert.equal(isOperationAllowed("write", envInfo), true);
    assert.equal(isOperationAllowed("delete", envInfo), true);
  });

  it("checks read permission", () => {
    const envInfo = {
      environment: "prod" as const,
      source: "env" as const,
      access: { read: true, write: false, delete: false },
    };
    assert.equal(isOperationAllowed("read", envInfo), true);
    assert.equal(isOperationAllowed("write", envInfo), false);
    assert.equal(isOperationAllowed("delete", envInfo), false);
  });

  it("checks write permission", () => {
    const envInfo = {
      environment: "staging" as const,
      source: "git" as const,
      access: { read: true, write: true, delete: false },
    };
    assert.equal(isOperationAllowed("read", envInfo), true);
    assert.equal(isOperationAllowed("write", envInfo), true);
    assert.equal(isOperationAllowed("delete", envInfo), false);
  });

  it("checks delete permission", () => {
    const envInfo = {
      environment: "dev" as const,
      source: "default" as const,
      access: { read: true, write: true, delete: true },
    };
    assert.equal(isOperationAllowed("read", envInfo), true);
    assert.equal(isOperationAllowed("write", envInfo), true);
    assert.equal(isOperationAllowed("delete", envInfo), true);
  });

  it("defaults to false when permission not specified", () => {
    // Test undefined permission values
    const envInfoPartial = {
      environment: "prod" as const,
      source: "env" as const,
      access: { read: undefined, write: undefined, delete: undefined },
    };
    assert.equal(isOperationAllowed("read", envInfoPartial as any), false);
    assert.equal(isOperationAllowed("write", envInfoPartial as any), false);
    assert.equal(isOperationAllowed("delete", envInfoPartial as any), false);
  });
});

describe("formatEnvironment", () => {
  it("formats environment from NODE_ENV", () => {
    const envInfo = {
      environment: "prod" as const,
      source: "env" as const,
    };
    assert.equal(formatEnvironment(envInfo), "prod (from NODE_ENV)");
  });

  it("formats environment from git", () => {
    const envInfo = {
      environment: "staging" as const,
      source: "git" as const,
    };
    assert.equal(formatEnvironment(envInfo), "staging (from git branch)");
  });

  it("formats environment from default", () => {
    const envInfo = {
      environment: "dev" as const,
      source: "default" as const,
    };
    assert.equal(formatEnvironment(envInfo), "dev (from default)");
  });
});

describe("isOperationAllowed — fail-closed and malformed input", () => {
  it("denies an operation name it does not recognise", () => {
    const envInfo = {
      environment: "prod" as const,
      source: "env" as const,
      access: { read: true, write: true, delete: true },
    };
    // The switch default must stay a deny: a caller that mistypes or a future
    // operation kind added to the union must not be silently granted access
    // just because every known permission happens to be true.
    assert.equal(isOperationAllowed("purge" as any, envInfo), false);
  });

  it("denies an operation name that differs only in case", () => {
    const envInfo = {
      environment: "prod" as const,
      source: "env" as const,
      access: { read: true, write: true, delete: true },
    };
    // Matching is exact and case-sensitive — "WRITE" is not "write".
    assert.equal(isOperationAllowed("WRITE" as any, envInfo), false);
    assert.equal(isOperationAllowed("Delete" as any, envInfo), false);
  });

  it("denies every operation when the access config is an empty object", () => {
    const envInfo = {
      environment: "prod" as const,
      source: "env" as const,
      access: {} as any,
    };
    // An access block that exists but lists no permissions is a deny-all, not
    // an allow-all: the backwards-compatible allow only applies when `access`
    // is entirely absent.
    assert.equal(isOperationAllowed("read", envInfo), false);
    assert.equal(isOperationAllowed("write", envInfo), false);
    assert.equal(isOperationAllowed("delete", envInfo), false);
  });

  it("denies every operation when permissions are null", () => {
    const envInfo = {
      environment: "prod" as const,
      source: "env" as const,
      access: { read: null, write: null, delete: null } as any,
    };
    // `?? false` catches null as well as undefined, so a config that round-trips
    // through JSON with explicit nulls still fails closed.
    assert.equal(isOperationAllowed("read", envInfo), false);
    assert.equal(isOperationAllowed("write", envInfo), false);
    assert.equal(isOperationAllowed("delete", envInfo), false);
  });

  it("returns a non-boolean permission value verbatim instead of coercing it", () => {
    const envInfo = {
      environment: "prod" as const,
      source: "env" as const,
      access: { read: "false", write: 0, delete: "no" } as any,
    };
    // Documents ACTUAL behaviour, which looks like a latent bug: `?? false`
    // only replaces null/undefined, so a permission that arrives as a string
    // (e.g. an unparsed TOML/env value) is handed straight back. The string
    // "false" and the string "no" are truthy, so `if (isOperationAllowed(...))`
    // would GRANT access for a config that reads as a denial.
    assert.equal(isOperationAllowed("read", envInfo) as unknown, "false");
    assert.equal(isOperationAllowed("delete", envInfo) as unknown, "no");
    // 0 is falsy, so this one happens to behave like a deny.
    assert.equal(isOperationAllowed("write", envInfo) as unknown, 0);
  });

  it("applies no implicit protection for prod beyond the access config", () => {
    const prod = {
      environment: "prod" as const,
      source: "git" as const,
      access: { read: true, write: true, delete: true },
    };
    const dev = {
      environment: "dev" as const,
      source: "git" as const,
      access: { read: true, write: true, delete: true },
    };
    // The environment name is NOT consulted — deletes in prod are allowed
    // purely because the config says so. Callers must not assume this function
    // hardens prod on its own.
    assert.equal(isOperationAllowed("delete", prod), true);
    assert.equal(isOperationAllowed("delete", prod), isOperationAllowed("delete", dev));
  });

  it("does not mutate the environment info it is given", () => {
    const access = { read: true, write: false, delete: false };
    const envInfo = { environment: "prod" as const, source: "env" as const, access };
    isOperationAllowed("read", envInfo);
    isOperationAllowed("write", envInfo);
    isOperationAllowed("delete", envInfo);
    isOperationAllowed("bogus" as any, envInfo);
    // The check is a pure read; callers reuse one EnvironmentInfo for many
    // checks and must not see permissions drift between them.
    assert.deepEqual(envInfo.access, { read: true, write: false, delete: false });
    assert.equal(envInfo.environment, "prod");
    assert.equal(envInfo.source, "env");
  });
});

describe("formatEnvironment — labels and unrecognised input", () => {
  it("renders the source label rather than the raw source key", () => {
    // The three labels are the user-facing wording; changing them changes CLI
    // output, so pin all three in one place.
    assert.equal(formatEnvironment({ environment: "dev", source: "env" }), "dev (from NODE_ENV)");
    assert.equal(formatEnvironment({ environment: "dev", source: "git" }), "dev (from git branch)");
    assert.equal(
      formatEnvironment({ environment: "dev", source: "default" }),
      "dev (from default)",
    );
  });

  it("renders 'undefined' as the label for an unrecognised source", () => {
    // ACTUAL behaviour, and arguably a bug: the lookup table has no fallback,
    // so an out-of-union source interpolates the literal string "undefined"
    // into user-facing output instead of degrading to something readable.
    assert.equal(
      formatEnvironment({ environment: "prod", source: "cli" as any }),
      "prod (from undefined)",
    );
    assert.equal(
      formatEnvironment({ environment: "prod", source: "" as any }),
      "prod (from undefined)",
    );
    assert.equal(
      formatEnvironment({ environment: "prod", source: undefined as any }),
      "prod (from undefined)",
    );
  });

  it("interpolates the environment name verbatim", () => {
    // No validation or normalisation happens here — whatever is in the field
    // reaches the terminal as-is.
    assert.equal(
      formatEnvironment({ environment: "PROD" as any, source: "env" }),
      "PROD (from NODE_ENV)",
    );
    assert.equal(
      formatEnvironment({ environment: "" as any, source: "git" }),
      " (from git branch)",
    );
  });

  it("never leaks the access permissions into the formatted string", () => {
    const withAccess = {
      environment: "prod" as const,
      source: "env" as const,
      access: { read: true, write: false, delete: false },
    };
    const withoutAccess = { environment: "prod" as const, source: "env" as const };
    // The description is safe to print anywhere: attaching an access block must
    // not change it, so permission detail cannot end up in logs via this path.
    assert.equal(formatEnvironment(withAccess), formatEnvironment(withoutAccess));
    assert.equal(formatEnvironment(withAccess), "prod (from NODE_ENV)");
  });
});
