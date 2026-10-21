import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { securityFindings } from "./monkey-test-security.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

describe("monkey-test immutable journal evidence", () => {
  it("does not mistake an append call for protection against update or delete", async () => {
    const root = mkdtempSync(join(tmpdir(), "kit-monkey-journal-"));
    mkdirSync(join(root, "src"));
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { stripe: "1.0.0" } }),
    );
    writeFileSync(
      join(root, "src", "payments.ts"),
      [
        "const tenant_id = request.auth.tenant_id;",
        "const event = stripe.webhooks.constructEvent(raw, sig, secret);",
        "await webhook_events.insert({ event_id: event.id });",
        "await stripe.refunds.create({ payment_intent: id });",
        "return charge.receipt_url;",
        "await journal.insert({ tenant_id, event });",
      ].join("\n"),
    );

    try {
      const findings = await securityFindings(root);
      assert.ok(findings.some((finding) => finding.title === "Immutable money journal not found"));
    } finally {
      rmTemp(root);
    }
  });
});
