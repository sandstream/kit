import assert from "node:assert/strict";
import { test } from "node:test";
import { scan } from "./standards-javascript.test-support.js";

test("measures source without executing imports or top-level code", () => {
  const result = scan(
    "import './missing.js'; throw new Error('Never execute this source');",
    "input.js",
  );
  assert.equal(result.didNotRun, false, result.issue);
  assert.deepEqual(
    result.findings.map(({ fn, ccn }) => [fn, ccn]),
    [["<module>", 1]],
  );
});

test("rejects syntax errors instead of accepting recovered partial syntax", () => {
  const result = scan("function broken( { private_source_marker");
  assert.equal(result.didNotRun, true);
  assert.deepEqual(result.findings, []);
  assert.doesNotMatch(JSON.stringify(result), /private_source_marker/);
});
