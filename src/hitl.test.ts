import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatHitlBlock,
  hitlBlockForService,
  hitlBlocksForSecrets,
  hitlBlocksForSecurity,
} from "./hitl.js";
import type { kitConfig } from "./config.js";

describe("HITL formatter", () => {
  it("renders the copyable human-in-the-loop contract", () => {
    const text = formatHitlBlock({
      blocker: "stripe is not authenticated",
      owner: "provider admin",
      reason: "auth / browser / external account",
      steps: ["Run `kit login --service stripe`.", "Run `kit check --category services`."],
      respondWith: "stripe authenticated; no secret values pasted",
      agentContinuesWith: "kit check --category services",
    });

    assert.match(text, /^HITL behövs$/m);
    assert.match(text, /^Blocker: stripe is not authenticated$/m);
    assert.match(text, /^Ägare: provider admin$/m);
    assert.match(text, /^Varför agenten inte kan lösa: auth \/ browser \/ external account$/m);
    assert.match(text, /^Gör detta:$/m);
    assert.match(text, /^1\. Run `kit login --service stripe`\.$/m);
    assert.match(text, /^Svara med: stripe authenticated; no secret values pasted$/m);
    assert.match(text, /^Agenten fortsätter med: kit check --category services$/m);
  });

  it("builds a service auth block with login, secret names, and re-check", () => {
    const config: kitConfig = {
      services: {
        stripe: { login: "stripe login", check: "stripe config --list" },
      },
      secrets: {
        keys: {
          STRIPE_SECRET_KEY: { source: "env" },
          STRIPE_WEBHOOK_SECRET: { source: "env" },
        },
      },
    };

    const block = hitlBlockForService(
      {
        name: "stripe",
        checkCommand: "stripe config --list",
        authenticated: false,
        output: "Command failed",
      },
      config,
    );

    assert.ok(block);
    assert.equal(block.owner, "provider admin");
    assert.equal(block.reason, "auth / browser / external account");
    assert.match(block.steps.join("\n"), /kit login --service stripe/);
    assert.match(block.steps.join("\n"), /STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET/);
    assert.equal(block.agentContinuesWith, "kit check --category services,secrets");
  });

  it("treats informational service checks as provider UI / DSN work", () => {
    const config: kitConfig = {
      services: {
        sentry: {
          login: "# sentry - no CLI login; get DSN from https://sentry.io",
          check: "# sentry - check SENTRY_DSN is set",
        },
      },
    };

    const block = hitlBlockForService(
      {
        name: "sentry",
        checkCommand: "# sentry - check SENTRY_DSN is set",
        authenticated: false,
        informational: true,
        output: "sentry - check SENTRY_DSN is set",
      },
      config,
    );

    assert.ok(block);
    assert.equal(block.reason, "provider UI / external account / secret");
    assert.match(block.steps.join("\n"), /get DSN from https:\/\/sentry\.io/);
    assert.match(block.steps.join("\n"), /SENTRY_DSN/);
  });

  it("groups missing secrets by backend and names keys without values", () => {
    const [block] = hitlBlocksForSecrets([
      {
        name: "DATABASE_URL",
        source: "env",
        available: false,
        detail: "Not set in environment",
      },
      {
        name: "SENTRY_DSN",
        source: "env",
        available: false,
        detail: "Not set in environment",
      },
    ]);

    assert.ok(block);
    assert.equal(block.blocker, "2 env secrets unavailable: DATABASE_URL, SENTRY_DSN");
    assert.equal(block.reason, "secret / config");
    assert.match(block.steps.join("\n"), /kit secrets set <KEY> --stdin/);
  });

  it("turns didNotRun security checks into setup handoff", () => {
    const [block] = hitlBlocksForSecurity([
      {
        category: "supply-chain",
        name: "osv-scanner",
        status: "warn",
        detail: "osv-scanner not installed",
        didNotRun: true,
        suggestion: "Install osv-scanner.",
      },
    ]);

    assert.ok(block);
    assert.equal(block.blocker, "osv-scanner did not run");
    assert.equal(block.reason, "scanner/check setup");
    assert.match(block.steps.join("\n"), /Install osv-scanner/);
  });
});
