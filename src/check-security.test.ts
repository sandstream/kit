import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { checkSecurity, parseTrivyMisconfigCount } from "./check-security.js";

describe("parseTrivyMisconfigCount", () => {
  it("counts only HIGH/CRITICAL misconfigurations", () => {
    const json = JSON.stringify({
      Results: [
        { Misconfigurations: [{ Severity: "HIGH" }, { Severity: "LOW" }, { Severity: "CRITICAL" }] },
        { Misconfigurations: [{ Severity: "MEDIUM" }] },
      ],
    });
    assert.strictEqual(parseTrivyMisconfigCount(json), 2);
  });

  it("returns 0 for a clean scan and -1 for unparseable output", () => {
    assert.strictEqual(parseTrivyMisconfigCount(JSON.stringify({ Results: [] })), 0);
    assert.strictEqual(parseTrivyMisconfigCount("not json"), -1);
  });
});

describe("checkSecurity", () => {
  // Bumblebee disabled so tests stay fast/offline (real scan downloads binary, walks machine).
  // Each test reuses a shared result set from a single checkSecurity() call to avoid
  // 5x cost on machines where ollama/etc are installed and respond slowly.
  let prevBumblebee: string | undefined;
  let cached: Awaited<ReturnType<typeof checkSecurity>>;

  before(async () => {
    prevBumblebee = process.env.KIT_BUMBLEBEE;
    process.env.KIT_BUMBLEBEE = "0";
    cached = await checkSecurity();
  });
  after(() => {
    if (prevBumblebee === undefined) delete process.env.KIT_BUMBLEBEE;
    else process.env.KIT_BUMBLEBEE = prevBumblebee;
  });

  it("returns an array of security check results", () => {
    assert.ok(Array.isArray(cached), "should return an array");
    assert.ok(cached.length > 0, "should have at least one check result");

    for (const result of cached) {
      assert.ok(result.category, "should have a category");
      assert.ok(result.name, "should have a name");
      assert.ok(result.status, "should have a status");
      assert.ok(result.detail, "should have a detail");
      assert.ok(
        ["pass", "fail", "warn", "skip"].includes(result.status),
        `status should be valid: ${result.status}`
      );
    }
  });

  it("includes npm audit check", () => {
    assert.ok(cached.find((r) => r.name === "npm audit"), "should include npm audit check");
  });

  it("includes service exposure checks", () => {
    assert.ok(cached.find((r) => r.name === "Ollama"), "should include Ollama exposure check");
    assert.ok(cached.find((r) => r.name === "Remote API"), "should include Remote API exposure check");
  });

  it("includes supply chain checks", () => {
    assert.ok(cached.find((r) => r.name === "pinned versions"), "should include pinned versions check");
  });

  it("includes secrets checks", () => {
    assert.ok(cached.find((r) => r.name === ".env gitignored"), "should include .env gitignored check");
    assert.ok(cached.find((r) => r.name === "secrets scan"), "should include secrets scan check");
  });
});
