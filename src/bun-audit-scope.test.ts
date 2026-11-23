import assert from "node:assert/strict";
import { it } from "node:test";
import { readBunAuditScope } from "./bun-audit-scope.js";

it("reads registry packages in a text lockfile with comments and trailing commas", () => {
  const text = `{
    "lockfileVersion": 1,
    "workspaces": { "": { "name": "root" }, "pkgs/child": { "name": "child" } },
    // The first package carries a URL inside a JSON string.
    "packages": {
      "example": ["example@1.0.0", "https://registry.npmjs.org/example/-/example-1.0.0.tgz", {}, "sha512-abc"],
      "child": ["child@workspace:pkgs/child"], /* child is local */
    },
  }`;
  assert.deepEqual(readBunAuditScope(text), new Set(["example"]));
});

it("refuses unknown lockfile versions and non-registry package links", () => {
  const root = { lockfileVersion: 1, workspaces: { "": { name: "root" } } };
  const cases = [
    { ...root, packages: { example: ["example@file:../example"] } },
    { ...root, packages: { example: ["example@1.0.0", "https://example.test/tarball"] } },
    { ...root, lockfileVersion: 2, packages: {} },
  ];
  for (const value of cases) {
    const result = readBunAuditScope(JSON.stringify(value));
    assert.ok("status" in result);
    assert.equal(result.status, "unsupported");
  }
});
