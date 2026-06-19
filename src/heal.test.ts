import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classify, isFailClosed, safeRecipe } from "./heal.js";
import type { SecurityCheckResult } from "./check-security.js";

const r = (over: Partial<SecurityCheckResult>): SecurityCheckResult => ({
  category: "supply-chain",
  name: "x",
  status: "warn",
  detail: "",
  ...over,
});

describe("kit heal — classification (safe / gated / fail-closed boundary)", () => {
  it("scanner-missing (suggestion `mise use <ref>`) → safe + has a recipe", () => {
    const f = r({
      name: "socket scan",
      category: "supply-chain",
      status: "warn",
      suggestion: "mise use npm:@socketsecurity/cli  (or: npm install -g @socketsecurity/cli)",
    });
    assert.equal(classify(f), "safe");
    assert.ok(safeRecipe(f));
  });

  it("missing .gitignore pattern → safe", () => {
    const f = r({ name: ".env gitignored", category: "exposure", status: "warn", detail: ".gitignore not found" });
    assert.equal(classify(f), "safe");
    assert.ok(safeRecipe(f));
  });

  it("checksum mismatch → FAIL-CLOSED (never safe, no recipe)", () => {
    const f = r({
      name: "bumblebee (supply-chain)",
      category: "supply-chain",
      status: "fail",
      detail: "scanner cached binary checksum mismatch (expected …, got …)",
      suggestion: "Do NOT trust it. Investigate for tampering (network MITM, compromised mirror).",
    });
    assert.equal(isFailClosed(f), true);
    assert.equal(classify(f), "fail-closed");
    assert.equal(safeRecipe(f), null);
  });

  it("destructive/outward finding → GATED (no safe recipe)", () => {
    const f = r({
      name: "leaked key in history",
      category: "secrets",
      status: "fail",
      detail: "committed secret value",
      suggestion: "kit secrets rotate STRIPE_KEY && kit secrets purge-history",
    });
    assert.equal(classify(f), "gated");
    assert.equal(safeRecipe(f), null);
  });

  it("isFailClosed only fires on a fail carrying a tamper signal", () => {
    assert.equal(isFailClosed(r({ status: "fail", detail: "2 high vulnerabilities" })), false);
    assert.equal(isFailClosed(r({ status: "warn", detail: "checksum mismatch" })), false); // warn, not fail
    assert.equal(isFailClosed(r({ status: "fail", detail: "scanner checksum mismatch" })), true);
  });
});
