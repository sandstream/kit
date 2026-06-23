import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { collectEscalations, formatEscalationMessage } from "./escalate.js";
import type { ToolStatus } from "./check-tools.js";
import type { ServiceStatus } from "./check-services.js";
import type { SecretStatus } from "./check-secrets.js";

describe("collectEscalations", () => {
  it("returns empty array when everything passes", () => {
    const tools: ToolStatus[] = [{ name: "node", required: "22", installed: "22.22.2", ok: true }];
    const services: ServiceStatus[] = [
      { name: "github", checkCommand: "gh auth status", authenticated: true, output: "ok" },
    ];
    const secrets: SecretStatus[] = [
      { name: "API_KEY", source: "env", available: true, detail: "set" },
    ];

    const items = collectEscalations(tools, services, secrets);
    assert.equal(items.length, 0);
  });

  it("collects failed tools", () => {
    const tools: ToolStatus[] = [{ name: "node", required: "22", installed: null, ok: false }];

    const items = collectEscalations(tools, [], []);
    assert.equal(items.length, 1);
    assert.equal(items[0].category, "tool");
    assert.equal(items[0].name, "node");
    assert.ok(items[0].issue.includes("Not installed"));
  });

  it("collects failed services", () => {
    const services: ServiceStatus[] = [
      {
        name: "github",
        checkCommand: "gh auth status",
        authenticated: false,
        output: "not logged in",
      },
    ];

    const items = collectEscalations([], services, []);
    assert.equal(items.length, 1);
    assert.equal(items[0].category, "service");
    assert.equal(items[0].name, "github");
  });

  it("renders an informational service as manual setup, not a `Run: #` command", () => {
    const services: ServiceStatus[] = [
      {
        name: "resend",
        checkCommand: "# resend — check RESEND_API_KEY is set",
        authenticated: false,
        output: "resend — check RESEND_API_KEY is set",
        informational: true,
      },
    ];

    const items = collectEscalations([], services, []);
    assert.equal(items.length, 1);
    assert.equal(items[0].issue, "Manual setup (no CLI login)");
    assert.ok(
      !items[0].action.startsWith("Run:"),
      `action should not be a Run: command, got: ${items[0].action}`,
    );
    assert.ok(items[0].action.includes("RESEND_API_KEY"));
  });

  it("collects missing secrets with source-specific actions", () => {
    const secrets: SecretStatus[] = [
      { name: "DB_URL", source: "1password", available: false, detail: "op read failed" },
      { name: "TOKEN", source: "env", available: false, detail: "Not set" },
      {
        name: "API_SECRET",
        source: "infisical",
        available: false,
        detail: "Not found in Infisical",
      },
    ];

    const items = collectEscalations([], [], secrets);
    assert.equal(items.length, 3);
    assert.ok(items[0].action.includes("1Password"));
    assert.ok(items[1].action.includes("TOKEN"));
    assert.ok(items[2].action.includes("Infisical"));
    assert.ok(items[2].action.includes("infisical secrets set"));
  });

  it("collects version mismatch tools", () => {
    const tools: ToolStatus[] = [{ name: "node", required: "22", installed: "20.10.0", ok: false }];

    const items = collectEscalations(tools, [], []);
    assert.equal(items.length, 1);
    assert.ok(items[0].issue.includes("20.10.0"));
    assert.ok(items[0].issue.includes("22"));
  });
});

describe("formatEscalationMessage", () => {
  it("returns success message when no items", () => {
    const msg = formatEscalationMessage([], "/project");
    assert.ok(msg.includes("no manual action needed"));
  });

  it("formats items grouped by category", () => {
    const items = [
      { category: "tool" as const, name: "node", issue: "Not installed", action: "Install node" },
      {
        category: "service" as const,
        name: "github",
        issue: "Not authenticated",
        action: "Run gh auth login",
      },
    ];

    const msg = formatEscalationMessage(items, "/my/project");
    assert.ok(msg.includes("2 issues"));
    assert.ok(msg.includes("/my/project"));
    assert.ok(msg.includes("Tools:"));
    assert.ok(msg.includes("Services:"));
    assert.ok(msg.includes("node: Not installed"));
  });
});
