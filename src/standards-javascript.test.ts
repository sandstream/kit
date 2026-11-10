import assert from "node:assert/strict";
import { test } from "node:test";
import { scan } from "./standards-javascript.test-support.js";

test("measures a branch after a nested object spread through the public source scanner", () => {
  const result = scan(
    [
      "function decide(flag: boolean) {",
      "  const env = { ...one(two()) };",
      "  if (flag) return 'yes';",
      "  return 'no';",
      "}",
    ].join("\n"),
  );
  assert.equal(result.didNotRun, false, result.issue);
  assert.deepEqual(result.files, ["input.ts"]);
  const body = result.findings.find((finding) => finding.fn === "decide");
  assert.ok(body, JSON.stringify(result.findings));
  assert.equal(body.ccn, 2);
  assert.equal(body.length, 5);
  assert.equal(body.metricVersion, "kit-js-ccn/v1");
  assert.equal(result.engineVersion, "5.9.3");
});
