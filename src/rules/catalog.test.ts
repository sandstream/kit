import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SECURITY_RULES, ruleForCheck } from "./catalog.js";

describe("rules catalog", () => {
  const sources = new Set(["cwe", "owasp", "asvs", "kit"]);

  it("every entry is well-formed", () => {
    for (const [name, rule] of Object.entries(SECURITY_RULES)) {
      assert.ok(name.length > 0, "check name is non-empty");
      assert.ok(rule.id.length > 0, `${name}: id non-empty`);
      assert.ok(sources.has(rule.source), `${name}: known source (${rule.source})`);
      assert.ok(rule.ref.startsWith("https://"), `${name}: ref is an https URL`);
      assert.ok(rule.title.length > 0, `${name}: title non-empty`);
    }
  });

  it("looks up a mapped check", () => {
    const env = ruleForCheck(".env gitignored");
    assert.equal(env?.id, "CWE-538");
    assert.equal(env?.source, "cwe");

    const audit = ruleForCheck("npm audit");
    assert.equal(audit?.id, "OWASP-A06");

    const secrets = ruleForCheck("secrets scan");
    assert.equal(secrets?.id, "CWE-798");
  });

  it("returns undefined for an unmapped or unknown check", () => {
    assert.equal(ruleForCheck("license check"), undefined); // intentionally unmapped
    assert.equal(ruleForCheck("does not exist"), undefined);
  });
});
