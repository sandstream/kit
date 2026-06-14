import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkServices } from "./check-services.js";

describe("checkServices", () => {
  it("returns empty array for empty services config", async () => {
    const results = await checkServices({});
    assert.deepEqual(results, []);
  });

  it("returns authenticated false when no check command configured", async () => {
    const results = await checkServices({
      myservice: {} as any,
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].name, "myservice");
    assert.equal(results[0].authenticated, false);
    assert.ok(results[0].output.includes("No check command"));
  });

  it("returns authenticated true when command succeeds", async () => {
    const results = await checkServices({
      node: { login: "node --version", check: "node --version" },
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].name, "node");
    assert.equal(results[0].authenticated, true);
    assert.equal(results[0].checkCommand, "node --version");
    assert.ok(results[0].output.length > 0);
  });

  it("returns authenticated false when command fails", async () => {
    const results = await checkServices({
      missing: { login: "", check: "definitely-not-a-real-command-xyz --version" },
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].authenticated, false);
  });

  it("checks multiple services independently", async () => {
    const results = await checkServices({
      node: { login: "node --version", check: "node --version" },
      missing: { login: "", check: "nonexistent-tool-abc --version" },
    });

    assert.equal(results.length, 2);
    const nodeResult = results.find((r) => r.name === "node")!;
    const missingResult = results.find((r) => r.name === "missing")!;

    assert.equal(nodeResult.authenticated, true);
    assert.equal(missingResult.authenticated, false);
  });

  it("flags '#'-prefixed check commands as informational without exec", async () => {
    const results = await checkServices({
      resend: { login: "", check: "# resend — set RESEND_API_KEY in env" } as any,
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].authenticated, false);
    assert.equal(results[0].informational, true);
    assert.ok(results[0].output.includes("RESEND_API_KEY"));
    assert.ok(!results[0].output.includes("ENOENT"));
  });

  it("includes check command in result", async () => {
    const results = await checkServices({
      myservice: { login: "node --version", check: "node --version" },
    });

    assert.equal(results[0].checkCommand, "node --version");
  });
});
