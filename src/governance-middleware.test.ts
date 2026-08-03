import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { withGovernance, checkGovernance, runGoverned } from "./governance-middleware.js";
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
function makeConfig(govOverrides: Partial<GovernanceConfig> = {}): kitConfig {
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
        withGovernance(config, { operation: "failing-op", operationType: "read" }, async () => {
          throw new Error("Something went wrong");
        }),
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

describe("runGoverned (MCP-safe, never prompts)", () => {
  let tempDir: string;
  let originalCwd: string;

  before(async () => {
    originalCwd = process.cwd();
    tempDir = await mkdtemp(join(tmpdir(), "kit-govmcp-"));
    process.chdir(tempDir);
  });
  after(async () => {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  });
  afterEach(async () => {
    await clearBudgetState();
  });

  it("runs and returns the result when governance is disabled", async () => {
    const r = await runGoverned(disabledConfig, { operation: "run", operationType: "write" }, () =>
      Promise.resolve("did-it"),
    );
    assert.deepEqual(r, { ok: true, result: "did-it" });
  });

  it("runs and returns the result when governance allows the op", async () => {
    const r = await runGoverned(makeConfig(), { operation: "run", operationType: "write" }, () =>
      Promise.resolve(42),
    );
    assert.equal(r.ok, true);
    assert.equal(r.result, 42);
  });

  it("denies (does NOT run) when the environment forbids writes — fail-closed, no throw", async () => {
    const config = makeConfig({
      environment: "staging",
      access: { staging: { read: true, write: false, delete: false } },
    });
    let executed = false;
    const r = await runGoverned(config, { operation: "run", operationType: "write" }, async () => {
      executed = true;
      return "nope";
    });
    assert.equal(r.ok, false);
    assert.equal(executed, false, "the op must not run when denied");
    assert.match(r.reason ?? "", /Write operations not allowed/);
  });

  it("denies a DESTRUCTIVE op even when the CLI would auto-approve it (no approval over MCP)", async () => {
    // withGovernance auto-approves this exact config; runGoverned must still refuse,
    // because approval cannot be requested over the MCP stdio channel.
    const config = makeConfig({
      approval: { destructive_operations: [], production_writes: false },
    });
    let executed = false;
    const r = await runGoverned(
      config,
      { operation: "cleanup", operationType: "delete", destructive: true },
      async () => {
        executed = true;
      },
    );
    assert.equal(r.ok, false);
    assert.equal(executed, false);
    assert.match(r.reason ?? "", /interactive approval/);
  });

  it("denies when the token budget is exceeded", async () => {
    const config = makeConfig({ agent: { max_tokens_per_day: 50, max_operations_per_hour: 100 } });
    await recordUsage(config.governance!, 40);
    const r = await runGoverned(
      config,
      { operation: "run", operationType: "write", estimatedTokens: 20 },
      () => Promise.resolve("x"),
    );
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /budget/i);
  });

  it("captures a thrown op as ok:false (never throws) and records no usage", async () => {
    const config = makeConfig({ agent: { max_tokens_per_day: 1000, max_operations_per_hour: 10 } });
    const r = await runGoverned(
      config,
      { operation: "run", operationType: "write", estimatedTokens: 100 },
      async () => {
        throw new Error("boom");
      },
    );
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /boom/);
    const status = await getBudgetStatus(config.governance);
    assert.equal(status.tokens_used, 0);
  });

  it("records usage after a successful governed op", async () => {
    const config = makeConfig({ agent: { max_tokens_per_day: 1000, max_operations_per_hour: 10 } });
    await runGoverned(
      config,
      { operation: "run", operationType: "write", estimatedTokens: 100 },
      () => Promise.resolve("ok"),
    );
    const status = await getBudgetStatus(config.governance);
    assert.equal(status.tokens_used, 100);
  });
});

describe("checkGovernance (pre-flight: deny ordering, fail-closed paths, warning shape)", () => {
  let tempDir: string;
  let originalCwd: string;

  before(async () => {
    originalCwd = process.cwd();
    tempDir = await mkdtemp(join(tmpdir(), "kit-govpreflight-"));
    process.chdir(tempDir);
  });

  after(async () => {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await clearBudgetState();
  });

  // Secret expiry is resolved from the universal `<KEY>_EXPIRES_AT` env hint
  // (secret-expiration.ts), so an expired/expiring secret can be simulated with
  // no store, no network and no real credential.
  function secretsFor(key: string): kitConfig["secrets"] {
    return { store: "env", keys: { [key]: { source: "env" } } };
  }

  function isoDaysFromNow(days: number): string {
    return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  }

  async function withEnv<T>(name: string, value: string, fn: () => Promise<T>): Promise<T> {
    const previous = process.env[name];
    process.env[name] = value;
    try {
      return await fn();
    } finally {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  }

  it("omits the warnings array entirely when governance is disabled", async () => {
    const result = await checkGovernance(disabledConfig, {
      operation: "check",
      operationType: "read",
    });
    // The disabled short-circuit returns `{ allowed: true }` with NO `warnings`
    // key, while every other allowed path returns an array. Callers must keep
    // treating `warnings` as optional — `result.warnings.length` would throw here.
    assert.equal(result.allowed, true);
    assert.equal(result.warnings, undefined);
  });

  it("denies when revocation is enabled but unconfigured (fail-closed, no process exit)", async () => {
    // revocation.enabled with no endpoint/agent.id cannot prove access is still
    // valid, so checkRevocationStatus assumes revoked. Unlike withGovernance,
    // checkGovernance must NOT call handleRevocation — that would process.exit(1)
    // on what is only a pre-flight query. This test completing proves it doesn't.
    const config = makeConfig({ revocation: { enabled: true } });
    const result = await checkGovernance(config, {
      operation: "read-config",
      operationType: "read",
    });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "Access has been revoked");
    assert.equal(result.warnings, undefined);
  });

  it("reports revocation ahead of an exhausted budget when both would deny", async () => {
    // Order is load-bearing: identity ("you are revoked") must win over a
    // recoverable quota message, or an operator chases the wrong problem.
    const config = makeConfig({
      revocation: { enabled: true },
      agent: { max_tokens_per_day: 50, max_operations_per_hour: 100 },
    });
    await recordUsage(config.governance!, 40);
    const result = await checkGovernance(config, {
      operation: "read-config",
      operationType: "read",
      estimatedTokens: 20,
    });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "Access has been revoked");
  });

  it("allows an operation that lands exactly on the token limit", async () => {
    // The deny condition is `used + estimated > limit`, so hitting the limit
    // exactly is still allowed. Flipping this to >= would deny the last legal op.
    const config = makeConfig({
      agent: { max_tokens_per_day: 100, max_operations_per_hour: 1000 },
    });
    await recordUsage(config.governance!, 90);
    const result = await checkGovernance(config, {
      operation: "check",
      operationType: "read",
      estimatedTokens: 10,
    });
    assert.equal(result.allowed, true);
    assert.deepEqual(result.warnings, []);
  });

  it("denies when a secret is already expired", async () => {
    const config: kitConfig = {
      ...makeConfig({ secrets: { check_expiration: true } }),
      secrets: secretsFor("kit_test_expired"),
    };
    const result = await withEnv("KIT_TEST_EXPIRED_EXPIRES_AT", isoDaysFromNow(-5), () =>
      checkGovernance(config, { operation: "deploy", operationType: "read" }),
    );
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "Expired secrets detected");
    // This deny path DOES carry the warnings collected so far (unlike the
    // revocation/budget/permission denials, which drop them).
    assert.deepEqual(result.warnings, []);
  });

  it("keeps the approval warning attached to an expired-secret denial", async () => {
    const config: kitConfig = {
      ...makeConfig({
        environment: "prod",
        access: { prod: { read: true, write: false, delete: false } },
        approval: { production_writes: true, destructive_operations: [] },
        secrets: { check_expiration: true },
      }),
      secrets: secretsFor("kit_test_expired2"),
    };
    const result = await withEnv("KIT_TEST_EXPIRED2_EXPIRES_AT", isoDaysFromNow(-1), () =>
      checkGovernance(config, { operation: "deploy", operationType: "write" }),
    );
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "Expired secrets detected");
    assert.deepEqual(result.warnings, ["This operation will require approval"]);
  });

  it("does not surface an approaching-expiry secret as a warning", async () => {
    const config: kitConfig = {
      ...makeConfig({ secrets: { check_expiration: true, warn_days_before_expiry: 30 } }),
      secrets: secretsFor("kit_test_soon"),
    };
    const result = await withEnv("KIT_TEST_SOON_EXPIRES_AT", isoDaysFromNow(5), () =>
      checkGovernance(config, { operation: "deploy", operationType: "read" }),
    );
    // Only EXPIRED secrets are reported; a key five days from expiry is allowed
    // AND silent here — checkGovernance never calls hasSecretWarnings, so a
    // pre-flight gives no runway warning. Asserted as-is, see notes.
    assert.equal(result.allowed, true);
    assert.deepEqual(result.warnings, []);
  });

  it("skips the secret-expiry check when the project declares no secret keys", async () => {
    // Gate is `check_expiration && config.secrets?.keys` — with no [secrets]
    // block the expiry probe is skipped outright, even for an expired env hint.
    const config = makeConfig({ secrets: { check_expiration: true } });
    const result = await withEnv("KIT_TEST_EXPIRED_EXPIRES_AT", isoDaysFromNow(-5), () =>
      checkGovernance(config, { operation: "deploy", operationType: "read" }),
    );
    assert.equal(result.allowed, true);
    assert.deepEqual(result.warnings, []);
  });

  it("reports a hard permission denial ahead of an expired secret", async () => {
    const config: kitConfig = {
      ...makeConfig({
        environment: "staging",
        access: { staging: { read: true, write: false, delete: false } },
        approval: { production_writes: false, destructive_operations: [] },
        secrets: { check_expiration: true },
      }),
      secrets: secretsFor("kit_test_expired3"),
    };
    const result = await withEnv("KIT_TEST_EXPIRED3_EXPIRES_AT", isoDaysFromNow(-2), () =>
      checkGovernance(config, { operation: "update", operationType: "write" }),
    );
    assert.equal(result.allowed, false);
    // Permission is step 3 and returns immediately, so the secret state is never
    // even probed — the reason is the permission one, not "Expired secrets detected".
    assert.match(result.reason ?? "", /Write operations not allowed in staging/);
    assert.equal(result.warnings, undefined);
  });

  it("does not warn about the approval a destructive operation will still need", async () => {
    // `destructive: true` is read by withGovernance (which prompts) but ignored
    // by checkGovernance: a permitted delete pre-flights clean with no warning,
    // so a caller relying on pre-flight cannot tell an approval prompt is coming.
    const config = makeConfig({
      access: { dev: { read: true, write: true, delete: true } },
    });
    const result = await checkGovernance(config, {
      operation: "drop-database",
      operationType: "delete",
      destructive: true,
    });
    assert.equal(result.allowed, true);
    assert.deepEqual(result.warnings, []);
  });
});
