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

describe("clearBudgetState", () => {
  let tempDir: string;
  let originalCwd: string;

  const enabledConfig: GovernanceConfig = { enabled: true, environment: "dev" };

  // The function resolves the state file against process.cwd() at call time,
  // so every case runs from inside a throwaway directory.
  before(async () => {
    originalCwd = process.cwd();
    tempDir = await mkdtemp(join(tmpdir(), "kit-budget-clear-"));
    process.chdir(tempDir);
  });

  after(async () => {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  });

  it("removes an existing budget state file from the current directory", async () => {
    const { existsSync } = await import("node:fs");
    const statePath = join(process.cwd(), ".kit-budget.json");
    await recordUsage(enabledConfig, 42);
    assert.equal(existsSync(statePath), true, "recordUsage should have written the state file");

    await clearBudgetState();
    assert.equal(existsSync(statePath), false);
  });

  it("resets the reported budget usage back to zero", async () => {
    await recordUsage(enabledConfig, 700);
    const statusBefore = await getBudgetStatus(enabledConfig);
    assert.equal(statusBefore.tokens_used, 700);

    await clearBudgetState();
    // With the file gone, loadBudgetState falls back to a fresh zeroed state —
    // this is the property that makes clearBudgetState usable as a test reset.
    const statusAfter = await getBudgetStatus(enabledConfig);
    assert.equal(statusAfter.tokens_used, 0);
    assert.equal(statusAfter.operations_used, 0);
  });

  it("does not throw when no budget state file exists", async () => {
    const { existsSync } = await import("node:fs");
    const statePath = join(process.cwd(), ".kit-budget.json");
    await clearBudgetState();
    assert.equal(existsSync(statePath), false);

    // Absent-file ENOENT is swallowed, so the call is idempotent and safe to
    // put in an unconditional afterEach hook (which this file itself does).
    await assert.doesNotReject(() => clearBudgetState());
  });

  it("removes a malformed state file without trying to parse it", async () => {
    const { existsSync } = await import("node:fs");
    const statePath = join(process.cwd(), ".kit-budget.json");
    await writeFile(statePath, "{ not json at all");

    await clearBudgetState();
    // A corrupt state file must still be clearable, otherwise a bad write
    // would wedge the budget counters permanently.
    assert.equal(existsSync(statePath), false);
  });

  it("leaves other files in the directory untouched", async () => {
    const { existsSync } = await import("node:fs");
    const decoys = [".kit-budget.json.bak", "kit-budget.json", "budget.json", ".kit-budget.jsonx"];
    for (const name of decoys) {
      await writeFile(join(process.cwd(), name), "keep me");
    }
    await recordUsage(enabledConfig, 1);

    await clearBudgetState();
    assert.equal(existsSync(join(process.cwd(), ".kit-budget.json")), false);
    for (const name of decoys) {
      // Only the exact ".kit-budget.json" name is targeted — no globbing.
      assert.equal(existsSync(join(process.cwd(), name)), true, `${name} should survive`);
      await rm(join(process.cwd(), name), { force: true });
    }
  });

  it("only clears the state file in the current working directory", async () => {
    const { existsSync } = await import("node:fs");
    const { mkdir } = await import("node:fs/promises");
    const here = join(tempDir, "here");
    const elsewhere = join(tempDir, "elsewhere");
    await mkdir(here, { recursive: true });
    await mkdir(elsewhere, { recursive: true });
    await writeFile(join(here, ".kit-budget.json"), "{}");
    await writeFile(join(elsewhere, ".kit-budget.json"), "{}");

    try {
      process.chdir(here);
      await clearBudgetState();
    } finally {
      process.chdir(tempDir);
    }

    assert.equal(existsSync(join(here, ".kit-budget.json")), false);
    // Another project's budget state must never be collateral damage.
    assert.equal(existsSync(join(elsewhere, ".kit-budget.json")), true);
    await rm(here, { recursive: true, force: true });
    await rm(elsewhere, { recursive: true, force: true });
  });

  it("fails quietly when the state path cannot be unlinked", async () => {
    const { mkdir } = await import("node:fs/promises");
    const statePath = join(process.cwd(), ".kit-budget.json");
    // A directory at the state path makes unlink fail (EISDIR/EPERM). The
    // function swallows every error, so callers get no signal that the state
    // survived — pinning the silence so a future rethrow is a deliberate change.
    await mkdir(statePath, { recursive: true });
    try {
      await assert.doesNotReject(() => clearBudgetState());
    } finally {
      await rm(statePath, { recursive: true, force: true });
    }
  });
});
