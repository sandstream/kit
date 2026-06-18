import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveToolBin } from "./resolveTool.js";

describe("resolveToolBin", () => {
  it("resolves an existing tool (node) to an absolute path", async () => {
    const p = await resolveToolBin("node");
    assert.ok(p, "node should resolve via mise or PATH");
    assert.ok(p!.startsWith("/"), `expected an absolute path, got: ${p}`);
  });

  it("returns null for a tool that does not exist anywhere", async () => {
    const p = await resolveToolBin("kit-definitely-not-a-real-tool-zzz");
    assert.equal(p, null);
  });
});
