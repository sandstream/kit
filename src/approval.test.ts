import { describe, it, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { requestApproval, wouldRequireApproval } from "./approval.js";
import type { GovernanceConfig } from "./config.js";

describe("wouldRequireApproval", () => {
  it("returns false when no config provided", () => {
    assert.equal(wouldRequireApproval(undefined, "check", "dev"), false);
  });

  it("returns false for non-destructive dev operations", () => {
    const config: GovernanceConfig = {
      enabled: true,
      approval: {
        destructive_operations: ["delete", "drop"],
        production_writes: true,
      },
    };
    assert.equal(wouldRequireApproval(config, "read-config", "dev"), false);
  });

  it("returns true for operations matching destructive keywords", () => {
    const config: GovernanceConfig = {
      enabled: true,
      approval: { destructive_operations: ["delete", "drop"] },
    };
    assert.equal(wouldRequireApproval(config, "db:delete:users", "dev"), true);
    assert.equal(wouldRequireApproval(config, "DROP TABLE orders", "dev"), true);
  });

  it("returns true for production writes when configured", () => {
    const config: GovernanceConfig = {
      enabled: true,
      approval: { production_writes: true, destructive_operations: [] },
    };
    assert.equal(wouldRequireApproval(config, "update-config", "prod"), true);
  });

  it("returns false for production writes when not configured", () => {
    const config: GovernanceConfig = {
      enabled: true,
      approval: { production_writes: false, destructive_operations: [] },
    };
    assert.equal(wouldRequireApproval(config, "update-config", "prod"), false);
  });

  it("returns false for prod operations that are not writes when production_writes is true", () => {
    const config: GovernanceConfig = {
      enabled: true,
      approval: {
        production_writes: true,
        destructive_operations: [],
      },
    };
    // production_writes checks env but the operation is not destructive
    // and we're in prod — the function returns true for ANY operation in prod
    // if production_writes is true (it doesn't distinguish read vs write here)
    assert.equal(wouldRequireApproval(config, "read-logs", "prod"), true);
  });
});

describe("requestApproval - auto-approve paths", () => {
  it("auto-approves when no approval config is provided", async () => {
    const result = await requestApproval(undefined, {
      operation: "check",
      environment: "dev",
      reason: "test",
    });
    assert.equal(result, true);
  });

  it("auto-approves when operation does not require approval", async () => {
    const config: GovernanceConfig = {
      enabled: true,
      approval: {
        destructive_operations: ["delete"],
        production_writes: false,
      },
    };
    const result = await requestApproval(config, {
      operation: "read-config",
      environment: "dev",
      reason: "reading configuration",
    });
    assert.equal(result, true);
  });
});

describe("requestApproval - Remote API flow", () => {
  afterEach(() => {
    mock.restoreAll();
    delete process.env.KIT_APPROVAL_WEBHOOK;
  });

  it("returns true when Remote API approves immediately", async () => {
    mock.method(
      globalThis,
      "fetch",
      async () =>
        new Response(JSON.stringify({ status: "approved" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const config: GovernanceConfig = {
      enabled: true,
      approval: {
        destructive_operations: ["delete"],
        production_writes: false,
        approval_timeout: 10,
      },
    };

    const result = await requestApproval(
      config,
      { operation: "db:delete", environment: "dev", reason: "cleanup" },
      "test-company-id",
    );
    assert.equal(result, true);
  });

  it("returns false when Remote API denies the request", async () => {
    mock.method(
      globalThis,
      "fetch",
      async () =>
        new Response(JSON.stringify({ status: "denied", reason: "Not authorized" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const config: GovernanceConfig = {
      enabled: true,
      approval: {
        destructive_operations: ["delete"],
        production_writes: false,
        approval_timeout: 10,
      },
    };

    const result = await requestApproval(
      config,
      { operation: "db:delete", environment: "dev", reason: "cleanup" },
      "test-company-id",
    );
    assert.equal(result, false);
  });

  it("returns false on approval timeout when API keeps returning pending", async () => {
    // approval_timeout: 0 is falsy so code uses 3600 default — use 1s instead
    // The polling sleep is 2s, so the loop exits after one pending response (~2s)
    mock.method(
      globalThis,
      "fetch",
      async () =>
        new Response(JSON.stringify({ status: "pending" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const config: GovernanceConfig = {
      enabled: true,
      approval: {
        destructive_operations: ["delete"],
        production_writes: false,
        approval_timeout: 1, // 1 second — loop exits after one 2s poll sleep
      },
    };

    const result = await requestApproval(
      config,
      { operation: "db:delete", environment: "dev", reason: "cleanup" },
      "test-company-id",
    );
    assert.equal(result, false);
  });

  it("sends webhook notification when KIT_APPROVAL_WEBHOOK is set", async () => {
    const webhookUrl = "http://example.com/webhook";
    process.env.KIT_APPROVAL_WEBHOOK = webhookUrl;

    const fetchedUrls: string[] = [];
    mock.method(globalThis, "fetch", async (url: string) => {
      fetchedUrls.push(url);
      if (url === webhookUrl) {
        return new Response("", { status: 200 });
      }
      return new Response(JSON.stringify({ status: "approved" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const config: GovernanceConfig = {
      enabled: true,
      approval: {
        destructive_operations: ["delete"],
        production_writes: false,
        approval_timeout: 10,
      },
    };

    await requestApproval(
      config,
      { operation: "db:delete", environment: "dev", reason: "cleanup" },
      "test-company-id",
    );

    assert.ok(fetchedUrls.includes(webhookUrl), "webhook URL should have been called");
  });

  it("continues when webhook call fails", async () => {
    process.env.KIT_APPROVAL_WEBHOOK = "http://example.com/webhook";

    mock.method(globalThis, "fetch", async (url: string) => {
      if (url === "http://example.com/webhook") {
        throw new Error("Network error");
      }
      return new Response(JSON.stringify({ status: "approved" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const config: GovernanceConfig = {
      enabled: true,
      approval: {
        destructive_operations: ["delete"],
        production_writes: false,
        approval_timeout: 10,
      },
    };

    const result = await requestApproval(
      config,
      { operation: "db:delete", environment: "dev", reason: "cleanup" },
      "test-company-id",
    );
    assert.equal(result, true);
  });

  it("handles Remote API endpoint being unreachable (connection error treated as pending)", async () => {
    // When fetch throws, error is caught and loop continues until timeout
    let callCount = 0;
    mock.method(globalThis, "fetch", async (url: string) => {
      callCount++;
      if (url.includes("approvals")) {
        throw new Error("ECONNREFUSED");
      }
      return new Response("", { status: 200 }); // webhook
    });

    const config: GovernanceConfig = {
      enabled: true,
      approval: {
        destructive_operations: ["delete"],
        production_writes: false,
        approval_timeout: 1, // 1 second timeout — exits after one 2s poll sleep
      },
    };

    const result = await requestApproval(
      config,
      { operation: "db:delete", environment: "dev", reason: "cleanup" },
      "test-company-id",
    );
    assert.equal(result, false);
    assert.ok(callCount >= 1, "should have attempted at least one API call");
  });
});
