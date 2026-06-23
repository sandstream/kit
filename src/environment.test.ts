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
