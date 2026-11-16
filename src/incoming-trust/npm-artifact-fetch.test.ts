import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseNpmArtifactUrl } from "./npm-artifact-fetch.js";

const good = "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz";

describe("parseNpmArtifactUrl", () => {
  it("accepts a canonical https URL and keeps the spelling", () => {
    const result = parseNpmArtifactUrl(good);
    assert.equal(result.status, "valid");
    assert.equal("source" in result && result.source, good);
  });

  const refused: [string, unknown, string][] = [
    ["a non-string", 42, "invalid-url"],
    ["whitespace", `${good} `, "invalid-url"],
    ["a backslash", "https://registry.npmjs.org\\x.tgz", "invalid-url"],
    ["a bad percent escape", "https://registry.npmjs.org/a%zz.tgz", "invalid-url"],
    ["credentials", "https://user:pw@registry.npmjs.org/a.tgz", "url-credentials"],
    ["a fragment", `${good}#x`, "url-fragment"],
    ["http", "http://registry.npmjs.org/a.tgz", "unsupported-protocol"],
    ["an upper-case host", "https://Registry.npmjs.org/a.tgz", "noncanonical-url"],
    ["a non-ASCII character", "https://registry.npmjs.org/\u00e5.tgz", "noncanonical-url"],
    ["an over-long URL", `https://registry.npmjs.org/${"a".repeat(8200)}`, "url-limit"],
  ];
  for (const [name, input, reason] of refused) {
    it(`refuses ${name}`, () => {
      const result = parseNpmArtifactUrl(input);
      assert.notEqual(result.status, "valid");
      assert.equal("reason" in result && result.reason, reason);
    });
  }
});
