import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findDepConfusion, findNonRegistryResolved } from "./supply-chain.js";

const lookalikes = [
  "https://evil.example/registry.npmjs.org/pkg/-/pkg-1.0.0.tgz",
  "https://evil.example/pkg.tgz?mirror=registry.npmjs.org/",
  "https://registry.npmjs.org.evil.example/pkg/-/pkg-1.0.0.tgz",
];

describe("registry host match", () => {
  it("does not treat a lookalike URL as the npm registry", () => {
    const pkgs = lookalikes.map((resolved, i) => ({
      path: `node_modules/p${i}`,
      name: `p${i}`,
      version: "1.0.0",
      resolved,
    }));
    assert.equal(findNonRegistryResolved(pkgs).length, lookalikes.length);
  });

  it("does not report a lookalike URL as a public-registry resolution", () => {
    const resolved = new Map([["@acme/core", lookalikes[0]]]);
    assert.deepEqual(findDepConfusion(["@acme/core"], resolved, ["@acme"]), []);
  });

  it("still accepts the real registry", () => {
    const real = [
      {
        path: "node_modules/ok",
        name: "ok",
        version: "1.0.0",
        resolved: "https://registry.npmjs.org/ok/-/ok-1.0.0.tgz",
      },
    ];
    assert.deepEqual(findNonRegistryResolved(real), []);
  });
});
