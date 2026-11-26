import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { kitConfig } from "./config.js";
import { buildInventory, lastRotations, rotationHint } from "./secrets-inventory.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const INLINE = "fakeinline-value-4c1d";
const CONFIG: kitConfig = {
  secrets: {
    keys: {
      STRIPE_SECRET_KEY: { source: "1password", ref: "op://Dev/payments/credential" },
      ALPHA_TOKEN: { source: "1password", ref: "op://Dev/alpha/credential" },
      OTHER_TOKEN: { source: "infisical" },
      INLINE_SETTING: { source: "config", value: INLINE },
    },
  },
};

describe("buildInventory", () => {
  it("filters by backend, sorts by name and never carries a value", () => {
    const one = buildInventory(CONFIG, { backend: "1password" });
    assert.deepEqual(
      one.map((e) => e.name),
      ["ALPHA_TOKEN", "STRIPE_SECRET_KEY"],
    );
    assert.equal(buildInventory(CONFIG).length, 4);
    assert.equal(buildInventory(CONFIG, { backend: "vault" }).length, 0);
    assert.ok(!JSON.stringify(buildInventory(CONFIG)).includes(INLINE));
  });

  it("names a --from-cli playbook where kit has one, otherwise manual", () => {
    assert.equal(rotationHint("STRIPE_SECRET_KEY").kind, "from-cli");
    assert.equal(rotationHint("SUPABASE_SERVICE_ROLE_KEY").kind, "supabase-mgmt-api");
    assert.equal(rotationHint("ALPHA_TOKEN").kind, "manual");
  });

  it("takes the last successful rotation per key from the audit log", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "kit-inventory-"));
    try {
      const ts = (d: string) => new Date(Date.now() - Number(d) * 86_400_000).toISOString();
      const rows = [
        {
          timestamp: ts("3"),
          operation: "secrets.rotate",
          success: true,
          metadata: { name: "ALPHA_TOKEN" },
        },
        {
          timestamp: ts("1"),
          operation: "secrets.rotate",
          success: false,
          metadata: { name: "ALPHA_TOKEN" },
        },
        {
          timestamp: ts("2"),
          operation: "secrets.sync",
          success: true,
          metadata: { name: "STRIPE_SECRET_KEY" },
        },
      ];
      writeFileSync(join(cwd, ".kit-audit.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n"));
      const rotations = await lastRotations(cwd);
      assert.equal(rotations.get("ALPHA_TOKEN"), rows[0]!.timestamp);
      assert.equal(rotations.has("STRIPE_SECRET_KEY"), false);
      const entry = buildInventory(CONFIG, { rotations }).find((e) => e.name === "ALPHA_TOKEN");
      assert.equal(entry?.lastRotated, rows[0]!.timestamp);
    } finally {
      rmTemp(cwd);
    }
  });
});
