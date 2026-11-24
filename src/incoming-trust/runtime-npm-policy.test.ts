import assert from "node:assert/strict";
import { it } from "node:test";
import { parseExpectedNpmArtifacts } from "./runtime-npm-policy.js";

it("requires one well-formed independent digest per package slot", () => {
  const row = {
    packagePath: "node_modules/example",
    name: "example",
    version: "1.0.0",
    sha256: "a".repeat(64),
  };
  assert.deepEqual(parseExpectedNpmArtifacts([row]), [row]);
  assert.equal(parseExpectedNpmArtifacts([row, row]), undefined);
  assert.equal(parseExpectedNpmArtifacts([{ ...row, sha256: "B".repeat(64) }]), undefined);
  assert.equal(
    parseExpectedNpmArtifacts([{ ...row, packagePath: "../node_modules/example" }]),
    undefined,
  );
});
