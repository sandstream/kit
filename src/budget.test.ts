import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  checkBudgetLimits,
  recordUsage,
  getBudgetStatus,
  formatBudgetStatus,
  clearBudgetState,
} from "./budget.js";
import type { GovernanceConfig } from "./config.js";

const disabledConfig: GovernanceConfig = { enabled: false };

const limitedConfig: GovernanceConfig = {
  enabled: true,
  environment: "dev",
  agent: {
    max_tokens_per_day: 1000,
    max_operations_per_hour: 10,
  },
};

describe("checkBudgetLimits", () => {
  let tempDir: string;
  let originalCwd: string;

  before(async () => {
    originalCwd = process.cwd();
    tempDir = await mkdtemp(join(tmpdir(), "kit-budget-check-"));
    process.chdir(tempDir);
  });

  after(async () => {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await clearBudgetState();
  });

  it("allows all operations when governance is disabled", async () => {
    const result = await checkBudgetLimits(disabledConfig, 9999999);
    assert.equal(result.allowed, true);
  });

  it("allows operations when within token limit", async () => {
    const result = await checkBudgetLimits(limitedConfig, 500);
    assert.equal(result.allowed, true);
  });

  it("allows operations exactly at token limit boundary", async () => {
    await recordUsage(limitedConfig, 500);
    // 500 + 500 = 1000 which is NOT > 1000 (strict greater-than check)
    const result = await checkBudgetLimits(limitedConfig, 500);
    assert.equal(result.allowed, true);
  });

  it("denies operations when token limit would be exceeded", async () => {
    await recordUsage(limitedConfig, 800);
    const result = await checkBudgetLimits(limitedConfig, 300);
    assert.equal(result.allowed, false);
    assert.ok(result.reason?.includes("Token budget exceeded"));
    assert.ok(result.reason?.includes("800/1000"));
  });

  it("denies operations when hourly operation limit is reached", async () => {
    const config: GovernanceConfig = {
      enabled: true,
      environment: "dev",
      agent: { max_operations_per_hour: 3 },
    };
    for (let i = 0; i < 3; i++) {
      await recordUsage(config, 0);
    }
    const result = await checkBudgetLimits(config, 0);
    assert.equal(result.allowed, false);
    assert.ok(result.reason?.includes("Operation budget exceeded"));
    assert.ok(result.reason?.includes("3/3"));
  });

  it("allows operations when no limits are configured", async () => {
    const config: GovernanceConfig = { enabled: true, environment: "dev" };
    const result = await checkBudgetLimits(config, 1000);
    assert.equal(result.allowed, true);
  });
});

describe("recordUsage", () => {
  let tempDir: string;
  let originalCwd: string;

  before(async () => {
    originalCwd = process.cwd();
    tempDir = await mkdtemp(join(tmpdir(), "kit-record-"));
    process.chdir(tempDir);
  });

  after(async () => {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await clearBudgetState();
  });

  it("increments token and operation counters", async () => {
    const config: GovernanceConfig = { enabled: true, environment: "dev" };
    await recordUsage(config, 150);
    const status = await getBudgetStatus(config);
    assert.equal(status.tokens_used, 150);
    assert.equal(status.operations_used, 1);
  });

  it("accumulates usage across multiple calls", async () => {
    const config: GovernanceConfig = { enabled: true, environment: "dev" };
    await recordUsage(config, 100);
    await recordUsage(config, 200);
    await recordUsage(config, 50);
    const status = await getBudgetStatus(config);
    assert.equal(status.tokens_used, 350);
    assert.equal(status.operations_used, 3);
  });

  it("does not write state when governance is disabled", async () => {
    await recordUsage(disabledConfig, 500);
    const config: GovernanceConfig = { enabled: true, environment: "dev" };
    const status = await getBudgetStatus(config);
    assert.equal(status.tokens_used, 0);
    assert.equal(status.operations_used, 0);
  });

  it("resets token counter when a new day begins", async () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    await writeFile(
      join(tempDir, ".kit-budget.json"),
      JSON.stringify({
        tokens_today: 900,
        operations_this_hour: 5,
        last_token_reset: yesterday.toISOString(),
        last_operation_reset: new Date().toISOString(),
      }),
    );
    const config: GovernanceConfig = { enabled: true, environment: "dev" };
    const status = await getBudgetStatus(config);
    assert.equal(status.tokens_used, 0);
    assert.equal(status.operations_used, 5);
  });

  it("resets operation counter after one hour has elapsed", async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await writeFile(
      join(tempDir, ".kit-budget.json"),
      JSON.stringify({
        tokens_today: 500,
        operations_this_hour: 8,
        last_token_reset: new Date().toISOString(),
        last_operation_reset: twoHoursAgo.toISOString(),
      }),
    );
    const config: GovernanceConfig = { enabled: true, environment: "dev" };
    const status = await getBudgetStatus(config);
    assert.equal(status.tokens_used, 500);
    assert.equal(status.operations_used, 0);
  });
});

describe("formatBudgetStatus", () => {
  it("includes token and operation usage with limits", () => {
    const output = formatBudgetStatus({
      tokens_used: 500,
      tokens_limit: 1000,
      operations_used: 3,
      operations_limit: 10,
    });
    assert.ok(output.includes("500"), "should include tokens used");
    assert.ok(output.includes("1,000"), "should include token limit");
    assert.ok(output.includes("50.0%"), "should include token percentage");
    assert.ok(output.includes("3"), "should include operations used");
    assert.ok(output.includes("10"), "should include operation limit");
    assert.ok(output.includes("30.0%"), "should include operation percentage");
  });

  it("shows 'no limit' when limits are not configured", () => {
    const output = formatBudgetStatus({
      tokens_used: 200,
      tokens_limit: undefined,
      operations_used: 5,
      operations_limit: undefined,
    });
    assert.ok(output.includes("200"), "should include tokens used");
    assert.ok(output.includes("no limit"), "should indicate no limit");
    assert.ok(output.includes("5"), "should include operations used");
  });

  it("includes Budget Status header", () => {
    const output = formatBudgetStatus({
      tokens_used: 0,
      tokens_limit: 100,
      operations_used: 0,
      operations_limit: 10,
    });
    assert.ok(output.includes("Budget Status"));
  });
});
