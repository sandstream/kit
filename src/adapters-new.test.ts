/**
 * Tests for PlanetScale, Loops, and Liveblocks adapters
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planetscaleDbAdapter } from "./adapters/planetscale-db.js";
import { loopsEmailAdapter } from "./adapters/loops-email.js";
import { liveblocksRealtimeAdapter } from "./adapters/liveblocks-realtime.js";

const mockContext = (env: Record<string, string> = {}, projectName?: string) => ({
  projectPath: "/tmp/test-project",
  projectName,
  existingEnv: env,
});

// ─── PlanetScale ──────────────────────────────────────────────────────────────

describe("planetscaleDbAdapter", () => {
  it("has correct name and description", () => {
    assert.equal(planetscaleDbAdapter.name, "planetscale/db");
    assert.ok(planetscaleDbAdapter.description.length > 0);
  });

  it("requires no CLI tools", () => {
    assert.deepEqual(planetscaleDbAdapter.getRequiredTools(), []);
  });

  it("check returns true when DATABASE_URL starts with mysql://", async () => {
    const result = await planetscaleDbAdapter.check(
      mockContext({ DATABASE_URL: "mysql://user:pass@host/db?ssl={}" })
    );
    assert.equal(result, true);
  });

  it("check returns false when DATABASE_URL is absent", async () => {
    assert.equal(await planetscaleDbAdapter.check(mockContext()), false);
  });

  it("check returns false when DATABASE_URL is not a mysql:// URL", async () => {
    const result = await planetscaleDbAdapter.check(
      mockContext({ DATABASE_URL: "postgres://user:pass@host/db" })
    );
    assert.equal(result, false);
  });

  it("provision returns existing secrets when DATABASE_URL already configured", async () => {
    const result = await planetscaleDbAdapter.provision(
      mockContext({
        DATABASE_URL: "mysql://user:pass@aws.connect.psdb.cloud/mydb",
        PLANETSCALE_HOST: "aws.connect.psdb.cloud",
        PLANETSCALE_USERNAME: "user",
        PLANETSCALE_PASSWORD: "pass",
      })
    );
    assert.equal(result.success, true);
    assert.equal(result.secrets?.DATABASE_URL, "mysql://user:pass@aws.connect.psdb.cloud/mydb");
    assert.ok(result.message.includes("already configured"));
  });

  it("provision returns error when service token credentials are missing", async () => {
    const result = await planetscaleDbAdapter.provision(mockContext());
    assert.equal(result.success, false);
    assert.ok(result.message.includes("PLANETSCALE_SERVICE_TOKEN_ID"), `missing in message: ${result.message}`);
    assert.ok(result.message.includes("PLANETSCALE_SERVICE_TOKEN"), `missing in message: ${result.message}`);
    assert.ok(result.message.includes("PLANETSCALE_ORG"), `missing in message: ${result.message}`);
  });

  it("provision reports which specific credentials are missing", async () => {
    // Only provide token ID, not the token or org
    const result = await planetscaleDbAdapter.provision(
      mockContext({ PLANETSCALE_SERVICE_TOKEN_ID: "tok_id_123" })
    );
    assert.equal(result.success, false);
    assert.ok(result.error?.includes("PLANETSCALE_SERVICE_TOKEN"), `expected missing token in error: ${result.error}`);
    assert.ok(result.error?.includes("PLANETSCALE_ORG"), `expected missing org in error: ${result.error}`);
  });
});

// ─── Loops ────────────────────────────────────────────────────────────────────

describe("loopsEmailAdapter", () => {
  it("has correct name and description", () => {
    assert.equal(loopsEmailAdapter.name, "loops/email");
    assert.ok(loopsEmailAdapter.description.length > 0);
  });

  it("requires no CLI tools", () => {
    assert.deepEqual(loopsEmailAdapter.getRequiredTools(), []);
  });

  it("check returns true when LOOPS_API_KEY is present", async () => {
    const result = await loopsEmailAdapter.check(
      mockContext({ LOOPS_API_KEY: "loops_abc123" })
    );
    assert.equal(result, true);
  });

  it("check returns false when LOOPS_API_KEY is missing", async () => {
    assert.equal(await loopsEmailAdapter.check(mockContext()), false);
  });

  it("provision returns existing key when LOOPS_API_KEY is set", async () => {
    const result = await loopsEmailAdapter.provision(
      mockContext({ LOOPS_API_KEY: "loops_existing_key" })
    );
    assert.equal(result.success, true);
    assert.equal(result.secrets?.LOOPS_API_KEY, "loops_existing_key");
    assert.ok(result.message.includes("already configured"));
  });

  it("provision returns error with setup instructions when key is missing", async () => {
    const result = await loopsEmailAdapter.provision(mockContext());
    assert.equal(result.success, false);
    assert.ok(result.message.includes("loops.so"), `expected dashboard URL in message: ${result.message}`);
    assert.ok(result.message.includes("LOOPS_API_KEY"), `expected key name in message: ${result.message}`);
  });
});

// ─── Liveblocks ───────────────────────────────────────────────────────────────

describe("liveblocksRealtimeAdapter", () => {
  it("has correct name and description", () => {
    assert.equal(liveblocksRealtimeAdapter.name, "liveblocks/realtime");
    assert.ok(liveblocksRealtimeAdapter.description.length > 0);
  });

  it("requires no CLI tools", () => {
    assert.deepEqual(liveblocksRealtimeAdapter.getRequiredTools(), []);
  });

  it("check returns true when LIVEBLOCKS_SECRET_KEY starts with sk_", async () => {
    const result = await liveblocksRealtimeAdapter.check(
      mockContext({ LIVEBLOCKS_SECRET_KEY: "sk_prod_abc123" })
    );
    assert.equal(result, true);
  });

  it("check returns false when LIVEBLOCKS_SECRET_KEY is absent", async () => {
    assert.equal(await liveblocksRealtimeAdapter.check(mockContext()), false);
  });

  it("check returns false when key does not start with sk_", async () => {
    const result = await liveblocksRealtimeAdapter.check(
      mockContext({ LIVEBLOCKS_SECRET_KEY: "pk_prod_abc123" })
    );
    assert.equal(result, false);
  });

  it("provision returns both keys when both are present", async () => {
    const result = await liveblocksRealtimeAdapter.provision(
      mockContext({
        LIVEBLOCKS_SECRET_KEY: "sk_prod_secret",
        NEXT_PUBLIC_LIVEBLOCKS_PUBLIC_KEY: "pk_prod_public",
      })
    );
    assert.equal(result.success, true);
    assert.equal(result.secrets?.LIVEBLOCKS_SECRET_KEY, "sk_prod_secret");
    assert.equal(result.secrets?.NEXT_PUBLIC_LIVEBLOCKS_PUBLIC_KEY, "pk_prod_public");
    assert.ok(result.message.includes("already configured"));
  });

  it("provision succeeds with only secret key present", async () => {
    const result = await liveblocksRealtimeAdapter.provision(
      mockContext({ LIVEBLOCKS_SECRET_KEY: "sk_dev_abc123" })
    );
    assert.equal(result.success, true);
    assert.equal(result.secrets?.LIVEBLOCKS_SECRET_KEY, "sk_dev_abc123");
    assert.ok(result.secrets?.NEXT_PUBLIC_LIVEBLOCKS_PUBLIC_KEY, "should include public key");
  });

  it("provision returns error with setup instructions when key is missing", async () => {
    const result = await liveblocksRealtimeAdapter.provision(mockContext());
    assert.equal(result.success, false);
    assert.ok(result.message.includes("liveblocks.io"), `expected dashboard URL: ${result.message}`);
    assert.ok(result.message.includes("LIVEBLOCKS_SECRET_KEY"), `expected key name: ${result.message}`);
  });
});
