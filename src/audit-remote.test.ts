import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { _resetRemotePushWarningForTests, logAuditEvent } from "./audit.js";
import type { GovernanceConfig } from "./config.js";

const originalFetch = globalThis.fetch;
const originalRemoteUrl = process.env.KIT_REMOTE_URL;

function remoteConfig(root: string): Required<GovernanceConfig> {
  return {
    enabled: true,
    environment: "dev",
    access: { dev: { read: true, write: true, delete: true } },
    agent: { id: "test-agent", name: "Test Agent" },
    audit: {
      enabled: true,
      log_file: join(root, ".kit-audit.jsonl"),
      include_secrets: false,
      remote: true,
      company_id: "company/with space",
    },
    approval: {},
    secrets: {},
    revocation: {},
    scan: {},
    containment: {},
  };
}

async function writeLegacyPending(
  root: string,
  secret: string,
  includeError = false,
): Promise<void> {
  const event: Record<string, unknown> = {
    timestamp: "2026-01-01T00:00:00.000Z",
    operation: `legacy ${secret}`,
    environment: "dev",
    success: false,
    metadata: { detail: secret },
  };
  if (includeError) event.error = `provider rejected ${secret}`;
  await writeFile(
    join(root, ".kit-audit.pending"),
    `${JSON.stringify({
      event,
      companyId: "legacy-company",
      parkedAt: "2026-01-01T00:00:00.000Z",
    })}\n`,
  );
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalRemoteUrl === undefined) delete process.env.KIT_REMOTE_URL;
  else process.env.KIT_REMOTE_URL = originalRemoteUrl;
  _resetRemotePushWarningForTests();
});

describe("remote audit delivery", () => {
  it("uses configured company_id without every caller threading an option", async () => {
    const root = mkdtempSync(join(tmpdir(), "kit-audit-remote-"));
    const requests: string[] = [];
    const oldError = console.error;
    console.error = () => {};
    try {
      process.env.KIT_REMOTE_URL = "https://audit.invalid";
      globalThis.fetch = (async (input) => {
        requests.push(String(input));
        return new Response(null, { status: 204 });
      }) as typeof fetch;

      const wrote = await logAuditEvent(
        remoteConfig(root),
        { operation: "test", environment: "dev", success: true },
        { cwd: root },
      );

      assert.equal(wrote, true);
      assert.deepEqual(requests, [
        "https://audit.invalid/api/companies/company%2Fwith%20space/audit-logs",
      ]);
    } finally {
      console.error = oldError;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("parks a failed remote event in the governed repo", async () => {
    const caller = mkdtempSync(join(tmpdir(), "kit-audit-caller-"));
    const target = mkdtempSync(join(tmpdir(), "kit-audit-target-"));
    const previousCwd = process.cwd();
    const oldError = console.error;
    console.error = () => {};
    try {
      process.chdir(caller);
      process.env.KIT_REMOTE_URL = "https://audit.invalid";
      globalThis.fetch = (async () => new Response(null, { status: 400 })) as typeof fetch;

      await logAuditEvent(
        remoteConfig(target),
        { operation: "test", environment: "dev", success: false },
        { cwd: target },
      );

      const targetQueue = join(target, ".kit-audit.pending");
      assert.equal(existsSync(targetQueue), true);
      assert.equal(existsSync(join(caller, ".kit-audit.pending")), false);
      const queued = JSON.parse((await readFile(targetQueue, "utf8")).trim());
      assert.equal(queued.companyId, "company/with space");
    } finally {
      process.chdir(previousCwd);
      console.error = oldError;
      rmSync(caller, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });
});

describe("remote audit diagnostics", () => {
  it("redacts credentials and secret-shaped identifiers from the shipping notice", async () => {
    const root = mkdtempSync(join(tmpdir(), "kit-audit-notice-"));
    const errors: string[] = [];
    const oldError = console.error;
    const companySecret = "ghp_" + "N".repeat(36);
    const config = remoteConfig(root);
    config.audit.company_id = companySecret;
    console.error = (...values: unknown[]) => errors.push(values.map(String).join(" "));
    try {
      process.env.KIT_REMOTE_URL = "https://audit-user:opaque-password@audit.invalid";
      globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;

      await logAuditEvent(
        config,
        { operation: "test", environment: "dev", success: true },
        { cwd: root },
      );

      const output = errors.join("\n");
      assert.ok(!output.includes("opaque-password"));
      assert.ok(!output.includes(companySecret));
      assert.match(output, /\[REDACTED\]/);
      assert.match(output, /audit\.invalid/);
    } finally {
      console.error = oldError;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("remote audit pending queue", () => {
  it("redacts opaque secrets from legacy queued events before delivery", async () => {
    const root = mkdtempSync(join(tmpdir(), "kit-audit-pending-redaction-"));
    const previousSecret = process.env.TEST_API_TOKEN;
    const oldError = console.error;
    const secret = "opaque-queued-audit-value-" + "Q".repeat(32);
    const bodies: string[] = [];
    console.error = () => {};
    try {
      process.env.TEST_API_TOKEN = secret;
      process.env.KIT_REMOTE_URL = "https://audit.invalid";
      await writeLegacyPending(root, secret, true);
      globalThis.fetch = (async (_input, init) => {
        bodies.push(String(init?.body));
        return new Response(null, { status: 204 });
      }) as typeof fetch;

      await logAuditEvent(
        remoteConfig(root),
        { operation: "current", environment: "dev", success: true },
        { cwd: root },
      );

      assert.equal(bodies.length, 2);
      assert.ok(!bodies.join("\n").includes(secret));
      assert.match(bodies[0], /\[REDACTED\]/);
    } finally {
      if (previousSecret === undefined) delete process.env.TEST_API_TOKEN;
      else process.env.TEST_API_TOKEN = previousSecret;
      console.error = oldError;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rewrites legacy queued secrets even when remote delivery still fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "kit-audit-pending-rewrite-"));
    const previousSecret = process.env.TEST_API_TOKEN;
    const oldError = console.error;
    const secret = "opaque-persisted-audit-value-" + "R".repeat(32);
    console.error = () => {};
    try {
      process.env.TEST_API_TOKEN = secret;
      process.env.KIT_REMOTE_URL = "https://audit.invalid";
      await writeLegacyPending(root, secret);
      globalThis.fetch = (async () => new Response(null, { status: 400 })) as typeof fetch;

      await logAuditEvent(
        remoteConfig(root),
        { operation: "current", environment: "dev", success: true },
        { cwd: root },
      );

      const queue = await readFile(join(root, ".kit-audit.pending"), "utf8");
      assert.ok(!queue.includes(secret));
      assert.match(queue, /\[REDACTED\]/);
    } finally {
      if (previousSecret === undefined) delete process.env.TEST_API_TOKEN;
      else process.env.TEST_API_TOKEN = previousSecret;
      console.error = oldError;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
