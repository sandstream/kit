import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("parses basic config without governance", async () => {
    const tmpFile = join(tmpdir(), `.kit-test-${process.pid}-1.toml`);
    await writeFile(
      tmpFile,
      `
[tools]
node = "22"
pnpm = "latest"

[services.github]
login = "gh auth login"
check = "gh auth status"
`,
      "utf-8"
    );

    try {
      const config = await loadConfig(tmpFile);
      assert.ok(config.tools);
      assert.equal(config.tools.node, "22");
      assert.equal(config.tools.pnpm, "latest");
      assert.ok(config.services);
      assert.ok(config.services.github);
      assert.equal(config.services.github.login, "gh auth login");
    } finally {
      await unlink(tmpFile);
    }
  });

  it("parses governance config with all sections", async () => {
    const tmpFile = join(tmpdir(), `.kit-test-${process.pid}-2.toml`);
    await writeFile(
      tmpFile,
      `
[governance]
enabled = true
environment = "staging"

[governance.access.dev]
read = true
write = true
delete = true

[governance.access.staging]
read = true
write = true
delete = false

[governance.access.prod]
read = true
write = false
delete = false

[governance.agent]
id = "test-agent-123"
name = "Test Agent"
max_tokens_per_day = 500000
max_operations_per_hour = 50

[governance.audit]
enabled = true
log_file = ".audit.jsonl"
log_level = "debug"
include_secrets = false

[governance.approval]
destructive_operations = ["delete", "drop", "truncate"]
production_writes = true
secret_rotations = false
approval_timeout = 1800

[governance.secrets]
check_expiration = true
warn_days_before_expiry = 14
rotate_on_expiry = false
revoke_on_agent_disable = true

[governance.revocation]
enabled = true
check_interval = 600
revocation_endpoint = "https://api.example.com/agents/{agent_id}/status"
`,
      "utf-8"
    );

    try {
      const config = await loadConfig(tmpFile);
      assert.ok(config.governance);
      assert.equal(config.governance.enabled, true);
      assert.equal(config.governance.environment, "staging");

      // Access control
      assert.ok(config.governance.access);
      assert.equal(config.governance.access.dev?.read, true);
      assert.equal(config.governance.access.dev?.write, true);
      assert.equal(config.governance.access.dev?.delete, true);
      assert.equal(config.governance.access.staging?.read, true);
      assert.equal(config.governance.access.staging?.write, true);
      assert.equal(config.governance.access.staging?.delete, false);
      assert.equal(config.governance.access.prod?.read, true);
      assert.equal(config.governance.access.prod?.write, false);
      assert.equal(config.governance.access.prod?.delete, false);

      // Agent config
      assert.ok(config.governance.agent);
      assert.equal(config.governance.agent.id, "test-agent-123");
      assert.equal(config.governance.agent.name, "Test Agent");
      assert.equal(config.governance.agent.max_tokens_per_day, 500000);
      assert.equal(config.governance.agent.max_operations_per_hour, 50);

      // Audit config
      assert.ok(config.governance.audit);
      assert.equal(config.governance.audit.enabled, true);
      assert.equal(config.governance.audit.log_file, ".audit.jsonl");
      assert.equal(config.governance.audit.log_level, "debug");
      assert.equal(config.governance.audit.include_secrets, false);

      // Approval config
      assert.ok(config.governance.approval);
      assert.ok(Array.isArray(config.governance.approval.destructive_operations));
      assert.equal(config.governance.approval.destructive_operations?.length, 3);
      assert.ok(
        config.governance.approval.destructive_operations?.includes("delete")
      );
      assert.equal(config.governance.approval.production_writes, true);
      assert.equal(config.governance.approval.secret_rotations, false);
      assert.equal(config.governance.approval.approval_timeout, 1800);

      // Secrets config
      assert.ok(config.governance.secrets);
      assert.equal(config.governance.secrets.check_expiration, true);
      assert.equal(config.governance.secrets.warn_days_before_expiry, 14);
      assert.equal(config.governance.secrets.rotate_on_expiry, false);
      assert.equal(config.governance.secrets.revoke_on_agent_disable, true);

      // Revocation config
      assert.ok(config.governance.revocation);
      assert.equal(config.governance.revocation.enabled, true);
      assert.equal(config.governance.revocation.check_interval, 600);
      assert.equal(
        config.governance.revocation.revocation_endpoint,
        "https://api.example.com/agents/{agent_id}/status"
      );
    } finally {
      await unlink(tmpFile);
    }
  });

  it("parses minimal governance config", async () => {
    const tmpFile = join(tmpdir(), `.kit-test-${process.pid}-3.toml`);
    await writeFile(
      tmpFile,
      `
[governance]
enabled = true
`,
      "utf-8"
    );

    try {
      const config = await loadConfig(tmpFile);
      assert.ok(config.governance);
      assert.equal(config.governance.enabled, true);
      // Other fields should be undefined
      assert.equal(config.governance.environment, undefined);
      assert.equal(config.governance.access, undefined);
    } finally {
      await unlink(tmpFile);
    }
  });

  it("parses config without governance section", async () => {
    const tmpFile = join(tmpdir(), `.kit-test-${process.pid}-4.toml`);
    await writeFile(
      tmpFile,
      `
[tools]
node = "22"
`,
      "utf-8"
    );

    try {
      const config = await loadConfig(tmpFile);
      assert.equal(config.governance, undefined);
    } finally {
      await unlink(tmpFile);
    }
  });

  it("throws a friendly error when tool version is a number instead of string", async () => {
    const tmpFile = join(tmpdir(), `.kit-test-${process.pid}-val1.toml`);
    await writeFile(tmpFile, `[tools]\nnode = 22\n`, "utf-8");
    try {
      await assert.rejects(
        () => loadConfig(tmpFile),
        (err: Error) => {
          assert.ok(err.message.includes("Invalid .kit.toml"), `expected 'Invalid .kit.toml' in: ${err.message}`);
          assert.ok(err.message.includes("tools.node"), `expected 'tools.node' in: ${err.message}`);
          return true;
        }
      );
    } finally {
      await unlink(tmpFile);
    }
  });

  it("throws a friendly error when secret source is an unknown enum value", async () => {
    const tmpFile = join(tmpdir(), `.kit-test-${process.pid}-val2.toml`);
    await writeFile(
      tmpFile,
      `[secrets.keys]\nMY_KEY = { source = "nonexistent-store", ref = "x" }\n`,
      "utf-8"
    );
    try {
      await assert.rejects(
        () => loadConfig(tmpFile),
        (err: Error) => {
          assert.ok(err.message.includes("Invalid .kit.toml"), `expected 'Invalid .kit.toml' in: ${err.message}`);
          return true;
        }
      );
    } finally {
      await unlink(tmpFile);
    }
  });

  it("succeeds but warns when an unknown top-level section is present", async () => {
    const tmpFile = join(tmpdir(), `.kit-test-${process.pid}-val3.toml`);
    await writeFile(
      tmpFile,
      `[tolls]\nnode = "22"\n`,
      "utf-8"
    );
    const warnMessages: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnMessages.push(String(args[0])); };
    try {
      const config = await loadConfig(tmpFile);
      assert.ok(config, "config should be returned without throwing");
      assert.ok(
        warnMessages.some((m) => m.includes("tolls")),
        `expected warning about 'tolls', got: ${JSON.stringify(warnMessages)}`
      );
    } finally {
      console.warn = originalWarn;
      await unlink(tmpFile);
    }
  });

  it("parses a full valid config with tools, secrets, and governance", async () => {
    const tmpFile = join(tmpdir(), `.kit-test-${process.pid}-val4.toml`);
    await writeFile(
      tmpFile,
      `
[tools]
node = "22"
pnpm = "latest"

[secrets]
store = "1password"
template = ".env.template"

[secrets.keys]
STRIPE_KEY = { source = "1password", ref = "op://Dev/Stripe/key" }

[governance]
enabled = true
environment = "dev"

[governance.access.prod]
read = true
write = false
delete = false
`,
      "utf-8"
    );
    try {
      const config = await loadConfig(tmpFile);
      assert.equal(config.tools?.node, "22");
      assert.equal(config.secrets?.store, "1password");
      assert.equal(config.secrets?.keys?.STRIPE_KEY?.source, "1password");
      assert.equal(config.governance?.enabled, true);
      assert.equal(config.governance?.access?.prod?.write, false);
    } finally {
      await unlink(tmpFile);
    }
  });
});
