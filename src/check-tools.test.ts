import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkTools } from "./check-tools.js";

describe("checkTools", () => {
  it("returns ok for a tool installed on PATH with 'latest' requirement", async () => {
    // node is always available in the test environment
    const results = await checkTools({ node: "latest" });

    assert.equal(results.length, 1);
    assert.equal(results[0].name, "node");
    assert.equal(results[0].required, "latest");
    assert.equal(results[0].ok, true);
    assert.ok(results[0].installed !== null, "node should report a version");
  });

  it("returns not ok for a tool that does not exist", async () => {
    const results = await checkTools({ "definitely-not-a-real-tool-xyz": "1.0" });

    assert.equal(results.length, 1);
    assert.equal(results[0].ok, false);
    assert.equal(results[0].installed, null);
  });

  it("checks multiple tools and returns individual results", async () => {
    const results = await checkTools({
      node: "latest",
      "nonexistent-tool-abc": "1.0",
    });

    assert.equal(results.length, 2);
    const nodeResult = results.find((r) => r.name === "node")!;
    const missingResult = results.find((r) => r.name === "nonexistent-tool-abc")!;

    assert.equal(nodeResult.ok, true);
    assert.equal(missingResult.ok, false);
    assert.equal(missingResult.installed, null);
  });

  it("returns ok when installed version matches required prefix", async () => {
    // node version starts with a number, check against major version prefix
    const nodeResults = await checkTools({ node: "latest" });
    const nodeVersion = nodeResults[0].installed;
    assert.ok(nodeVersion !== null, "need node version for this test");

    // Extract major version (e.g., "22" from "22.1.0")
    const major = nodeVersion!.split(".")[0];

    const results = await checkTools({ node: major });
    assert.equal(results[0].ok, true);
  });

  it("returns not ok when installed version does not match required prefix", async () => {
    // Use an impossibly high version number that no installed node could match
    const results = await checkTools({ node: "999" });
    assert.equal(results[0].ok, false);
    assert.ok(results[0].installed !== null, "node should still show installed version");
  });

  it("returns empty array for empty tool config", async () => {
    const results = await checkTools({});
    assert.deepEqual(results, []);
  });

  it("detects a tool via the resolver when it is not on PATH (mise-global case)", async () => {
    // A globally mise-installed tool isn't on PATH when mise isn't activated in the
    // shell, but resolveToolBin finds it via `mise which`. Stand in for that resolved
    // binary with the real node executable so the version read is deterministic.
    const results = await checkTools(
      { "mise-global-tool": "latest" },
      async () => process.execPath,
    );
    assert.equal(results[0].ok, true);
    assert.ok(results[0].installed !== null, "resolved tool should report a version");
  });

  it("reports not installed when the resolver finds nothing", async () => {
    const results = await checkTools({ "ghost-tool": "1.0" }, async () => null);
    assert.equal(results[0].ok, false);
    assert.equal(results[0].installed, null);
  });
});
