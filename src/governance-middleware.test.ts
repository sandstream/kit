import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  withGovernance,
  checkGovernance,
} from "./governance-middleware.js";
import { clearBudgetState, getBudgetStatus, recordUsage } from "./budget.js";
import type { kitConfig, GovernanceConfig } from "./config.js";

// Governance disabled — all calls should pass through immediately
const disabledConfig: kitConfig = {
  governance: { enabled: false },
};

// Returns a kitConfig with governance enabled and safe test defaults:
// - explicit environment (no git detection)
// - audit disabled (no file writes)
// - revocation disabled (no network calls)
// - secret expiry disabled (no network calls)
// - approval that auto-approves everything (no readline / API calls)
function makeConfig(
  govOverrides: Partial<GovernanceConfig> = {},
): kitConfig {
  return {
    governance: {
      enabled: true,
      environment: "dev",
      audit: { enabled: false },
      revocation: { enabled: false },
      secrets: { check_expiration: false },
      approval: { destructive_operations: [], production_writes: false },
      ...govOverrides,
    },
  };
}

describe("checkGovernance", () => {
  let tempDir: string;
  let originalCwd: string;

  before(async () => {
    originalCwd = process.cwd();
    tempDir = await mkdtemp(join(tmpdir(), "kit-govcheck-"));
    process.chdir(tempDir);
  });

  after(async () => {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await clearBudgetState();
  });

  it("returns allowed when governance is disabled", async () => {
    const result = await checkGovernance(disabledConfig, {
      operation: "check",
      operationType: "read",
    });
    assert.equal(result.allowed, true);
  });

  it("allows read operations in dev environment", async () => {
    const config = makeConfig({
      access: { dev: { read: true, write: true, delete: true } },
    });
    const result = await checkGovernance(config, {
      operation: "read-config",
      operationType: "read",
    });
    assert.equal(result.allowed, true);
    assert.deepEqual(result.warnings, []);
  });

  it("allows write operations in dev environment", async () => {
    const config = makeConfig({
      access: { dev: { read: true, write: true, delete: true } },
    });
    const result = await checkGovernance(config, {
      operation: "update-config",
      operationType: "write",
    });
    assert.equal(result.allowed, true);
  });

  it("returns denied when write is not allowed in staging without approval", async () => {
    const config = makeConfig({
      environment: "staging",
      access: { staging: { read: true, write: false, delete: false } },
    });
    const result = await checkGovernance(config, {
      operation: "update-config",
      operationType: "write",
    });
    assert.equal(result.allowed, false);
    assert.ok(result.reason?.includes("Write operations not allowed"));
  });

  it("returns denied when read is explicitly not allowed", async () => {
    const config = makeConfig({
      access: { dev: { read: false, write: false, delete: false } },
    });
    const result = await checkGovernance(config, {
      operation: "read-config",
      operationType: "read",
    });
    assert.equal(result.allowed, false);
    assert.ok(result.reason?.includes("Read operations not allowed"));
  });

  it("returns allowed with approval warning for write in prod with production_writes enabled", async () => {
    const config = makeConfig({
      environment: "prod",
      access: { prod: { read: true, write: false, delete: false } },
      approval: { production_writes: true, destructive_operations: [] },
    });
    const result = await checkGovernance(config, {
      operation: "deploy",
      operationType: "write",
    });
    assert.equal(result.allowed, true);
    assert.ok(
      result.warnings?.some((w) => w.includes("approval")),
      "should include approval warning",
    );
  });

  it("returns allowed with approval warning for delete in staging", async () => {
    const config = makeConfig({
      environment: "staging",
      access: { staging: { read: true, write: true, delete: false } },
    });
    const result = await checkGovernance(config, {
      operation: "cleanup",
      operationType: "delete",
    });
    // delete not allowed requires approval → warning, still "allowed" (pre-flight)
    assert.equal(result.allowed, true);
    assert.ok(
      result.warnings?.some((w) => w.includes("approval")),
      "should include approval warning",
    );
  });

  it("returns denied when token budget is exceeded", async () => {
    const config = makeConfig({
      agent: { max_tokens_per_day: 100, max_operations_per_hour: 50 },
    });
    await recordUsage(config.governance!, 90);
    const result = await checkGovernance(config, {
      operation: "check",
      operationType: "read",
      estimatedTokens: 20,
    });
    assert.equal(result.allowed, false);
    assert.ok(result.reason?.includes("Token budget exceeded"));
  });

  it("returns denied when operation limit is reached", async () => {
    const config = makeConfig({
      agent: { max_operations_per_hour: 2, max_tokens_per_day: 100000 },
    });
    await recordUsage(config.governance!, 0);
    await recordUsage(config.governance!, 0);
    const result = await checkGovernance(config, {
      operation: "check",
      operationType: "read",
    });
    assert.equal(result.allowed, false);
    assert.ok(result.reason?.includes("Operation budget exceeded"));
  });
});

describe("withGovernance", () => {
  let tempDir: string;
  let originalCwd: string;

  before(async () => {
    originalCwd = process.cwd();
    tempDir = await mkdtemp(join(tmpdir(), "kit-govwith-"));
    process.chdir(tempDir);
  });

  after(async () => {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await clearBudgetState();
  });

  it("executes operation when governance is disabled", async () => {
    let executed = false;
    await withGovernance(
      disabledConfig,
      { operation: "check", operationType: "read" },
      async () => {
        executed = true;
      },
    );
    assert.equal(executed, true);
  });

  it("returns operation result when governance allows it", async () => {
    const config = makeConfig();
    const result = await withGovernance(
      config,
      { operation: "read-config", operationType: "read" },
      async () => "operation-result",
    );
    assert.equal(result, "operation-result");
  });

  it("throws when operation is not allowed by environment rules", async () => {
    const config = makeConfig({
      environment: "staging",
      access: { staging: { read: true, write: false, delete: false } },
    });
    await assert.rejects(
      () =>
        withGovernance(
          config,
          { operation: "update", operationType: "write" },
          async () => "result",
        ),
      /Write operations not allowed/,
    );
  });

  it("throws when token budget is exceeded", async () => {
    const config = makeConfig({
      agent: { max_tokens_per_day: 50, max_operations_per_hour: 100 },
    });
    await recordUsage(config.governance!, 40);
    await assert.rejects(
      () =>
        withGovernance(
          config,
          { operation: "check", operationType: "read", estimatedTokens: 20 },
          async () => "result",
        ),
      /Token budget exceeded/,
    );
  });

  it("propagates errors thrown by the operation", async () => {
    const config = makeConfig();
    await assert.rejects(
      () =>
        withGovernance(
          config,
          { operation: "failing-op", operationType: "read" },
          async () => {
            throw new Error("Something went wrong");
          },
        ),
      /Something went wrong/,
    );
  });

  it("records token and operation usage after successful execution", async () => {
    const config = makeConfig({
      agent: { max_tokens_per_day: 1000, max_operations_per_hour: 10 },
    });
    await withGovernance(
      config,
      { operation: "check", operationType: "read", estimatedTokens: 100 },
      async () => "done",
    );
    const status = await getBudgetStatus(config.governance);
    assert.equal(status.tokens_used, 100);
    assert.equal(status.operations_used, 1);
  });

  it("does not record usage when operation fails", async () => {
    const config = makeConfig({
      agent: { max_tokens_per_day: 1000, max_operations_per_hour: 10 },
    });
    await assert.rejects(
      () =>
        withGovernance(
          config,
          { operation: "failing-op", operationType: "read", estimatedTokens: 100 },
          async () => {
            throw new Error("op failed");
          },
        ),
      /op failed/,
    );
    const status = await getBudgetStatus(config.governance);
    assert.equal(status.tokens_used, 0);
    assert.equal(status.operations_used, 0);
  });

  it("auto-approves destructive context when no approval criteria are met", async () => {
    // With destructive_operations: [] and production_writes: false,
    // requestApproval returns true immediately without user interaction
    const config = makeConfig({
      approval: { destructive_operations: [], production_writes: false },
    });
    let executed = false;
    await withGovernance(
      config,
      { operation: "cleanup", operationType: "delete", destructive: true },
      async () => {
        executed = true;
      },
    );
    assert.equal(executed, true);
  });
});
