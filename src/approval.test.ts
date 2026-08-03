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

describe("wouldRequireApproval - defaults, boundaries and fail-closed edges", () => {
  it("predicts NO approval when config is absent, because governance defaults to off", () => {
    // DEFAULT_GOVERNANCE.enabled is false, and `withGovernance` returns before any
    // approval is requested when governance is off — so no prompt can happen and
    // predicting one would be a lie. This function used to ignore `enabled` and report
    // true here, disagreeing with the code it exists to predict.
    assert.equal(wouldRequireApproval(undefined, "db:delete:users", "dev"), false);
    assert.equal(wouldRequireApproval(undefined, "destroy stack", "dev"), false);
    assert.equal(wouldRequireApproval(undefined, "read-logs", "prod"), false);
  });

  it("applies the built-in destructive keywords once governance is enabled", () => {
    // Enabling governance is the only thing the absent-config case was missing: the
    // default keyword list (delete/drop/truncate/destroy/remove) is already there.
    const on: GovernanceConfig = { enabled: true };
    assert.equal(wouldRequireApproval(on, "db:delete:users", "dev"), true);
    assert.equal(wouldRequireApproval(on, "truncate audit log", "dev"), true);
    assert.equal(wouldRequireApproval(on, "destroy stack", "dev"), true);
  });

  it("gates every prod operation when enabled, because production_writes defaults to true", () => {
    // Regression guard: flipping the default of production_writes to false would
    // silently open prod to unapproved operations.
    assert.equal(wouldRequireApproval({ enabled: true }, "read-logs", "prod"), true);
  });

  it("predicts no approval when governance is explicitly disabled", () => {
    const config: GovernanceConfig = { enabled: false };
    assert.equal(wouldRequireApproval(config, "db:drop", "dev"), false);
    assert.equal(wouldRequireApproval(config, "read-logs", "prod"), false);
  });

  it("keeps the default keywords when approval is present but empty", () => {
    // `approval: {}` is a partial override merged over the defaults, not a reset.
    const config: GovernanceConfig = { enabled: true, approval: {} };
    assert.equal(wouldRequireApproval(config, "drop table orders", "dev"), true);
  });

  it("disables destructive gating when destructive_operations is an explicit empty list", () => {
    // An explicitly empty array replaces the defaults, so nothing matches by keyword.
    const config: GovernanceConfig = {
      enabled: true,
      approval: { destructive_operations: [], production_writes: false },
    };
    assert.equal(wouldRequireApproval(config, "drop table orders", "dev"), false);
    assert.equal(wouldRequireApproval(config, "destroy everything", "dev"), false);
  });

  it("matches keywords case-insensitively in both directions", () => {
    const config: GovernanceConfig = {
      enabled: true,
      approval: { destructive_operations: ["DELETE"], production_writes: false },
    };
    // Both the configured keyword and the operation are lowercased before comparison,
    // so an upper-case policy entry must not stop matching a lower-case operation.
    assert.equal(wouldRequireApproval(config, "db:delete:users", "dev"), true);
    assert.equal(wouldRequireApproval(config, "DB:DELETE:USERS", "dev"), true);
  });

  it("matches keywords as bare substrings, with no word boundaries", () => {
    const config: GovernanceConfig = {
      enabled: true,
      approval: { destructive_operations: ["delete", "rm"], production_writes: false },
    };
    // "undelete" is not a delete and "confirm" merely contains "rm": naive containment
    // over-matches rather than under-matches, so it errs towards requiring approval.
    // Switching to word-boundary matching would turn today's denials into silent allows.
    assert.equal(wouldRequireApproval(config, "undelete-restore", "dev"), true);
    assert.equal(wouldRequireApproval(config, "confirm-changes", "dev"), true);
  });

  it("treats an empty keyword as matching every operation", () => {
    const config: GovernanceConfig = {
      enabled: true,
      approval: { destructive_operations: [""], production_writes: false },
    };
    // "".includes("") === true, so a stray empty entry gates everything, including
    // the empty operation name. Fail-closed, but surprising.
    assert.equal(wouldRequireApproval(config, "read-config", "dev"), true);
    assert.equal(wouldRequireApproval(config, "", "dev"), true);
  });

  it("returns false for an empty operation name when no keyword is empty", () => {
    const config: GovernanceConfig = {
      enabled: true,
      approval: { destructive_operations: ["delete"], production_writes: false },
    };
    assert.equal(wouldRequireApproval(config, "", "dev"), false);
  });

  it("compares the environment exactly, so only the literal string prod is gated", () => {
    const config: GovernanceConfig = {
      enabled: true,
      approval: { destructive_operations: [], production_writes: true },
    };
    assert.equal(wouldRequireApproval(config, "update-config", "prod"), true);
    // Any other spelling of production bypasses the prod gate entirely — a caller
    // passing "production" or "PROD" gets no approval requirement.
    assert.equal(wouldRequireApproval(config, "update-config", "production"), false);
    assert.equal(wouldRequireApproval(config, "update-config", "PROD"), false);
    assert.equal(wouldRequireApproval(config, "update-config", ""), false);
  });

  it("agrees with the enforcer on a truthy non-boolean production_writes", () => {
    // The divergence this pins: `requestApproval` — the code this function predicts —
    // gates prod on bare truthiness. While the prediction used `=== true`, a
    // hand-edited TOML value like `production_writes = "yes"` made a dry-run report
    // "no approval needed" and the real call then prompt or deny. A predictor may
    // over-predict a prompt; it must never under-predict one.
    const truthy: GovernanceConfig = {
      enabled: true,
      approval: { destructive_operations: [], production_writes: "yes" as unknown as boolean },
    };
    assert.equal(wouldRequireApproval(truthy, "update-config", "prod"), true);

    // And a falsy non-boolean still means no prod gate, matching the enforcer again.
    const falsy: GovernanceConfig = {
      enabled: true,
      approval: { destructive_operations: [], production_writes: "" as unknown as boolean },
    };
    assert.equal(wouldRequireApproval(falsy, "update-config", "prod"), false);
  });

  it("requires approval for a destructive prod operation even when production_writes is off", () => {
    const config: GovernanceConfig = {
      enabled: true,
      approval: { destructive_operations: ["drop"], production_writes: false },
    };
    // The two conditions are OR'd: turning off production_writes must not disarm
    // the destructive-keyword check in prod.
    assert.equal(wouldRequireApproval(config, "db:drop:orders", "prod"), true);
  });
});
