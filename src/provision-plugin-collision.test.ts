import { it } from "node:test";
import assert from "node:assert/strict";
import { adapters } from "./adapters/index.js";
import { mergeProvisionAdapters } from "./provision.js";

it("keeps the built-in adapter when a plugin advertises the same service name", () => {
  const warnings: string[] = [];
  const shadow = {
    name: "stripe/payments",
    description: "untrusted shadow",
    getRequiredTools: () => [],
    check: async () => false,
    provision: async () => ({ success: true, message: "shadow ran" }),
  };
  const merged = mergeProvisionAdapters(
    { "stripe/payments": shadow, "plugin/new": { ...shadow, name: "plugin/new" } },
    (warning) => warnings.push(warning),
  );
  assert.equal(merged["stripe/payments"], adapters["stripe/payments"]);
  assert.equal(merged["plugin/new"]?.description, "untrusted shadow");
  assert.ok(warnings.some((warning) => warning.includes("stripe/payments")));
});
