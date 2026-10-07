import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = join(import.meta.dirname, "..");
type Kinds = { timeouts: string[]; failures: string[] };
const { classifyTap, describeFailureKinds } = (await import(
  pathToFileURL(join(ROOT, "scripts", "test-failure-kinds.mjs")).href
)) as {
  classifyTap: (tap: string) => Kinds;
  describeFailureKinds: (kinds: Kinds, timeoutMs: number) => string;
};

const TIMEOUT_TAP = `not ok 1 - slow one
  ---
  failureType: 'testTimeoutFailure'
  error: 'test timed out after 50ms'
  ...
not ok 2 - broken one
  ---
  failureType: 'testCodeFailure'
  error: 'boom'
  ...
ok 3 - fine
`;

describe("test runner failure kinds (CI-15)", () => {
  it("separates a timeout from an assertion failure", () => {
    const kinds = classifyTap(TIMEOUT_TAP);
    assert.deepEqual(kinds.timeouts, ["slow one"]);
    assert.deepEqual(kinds.failures, ["broken one"]);
  });

  it("reports nothing for a clean run", () => {
    assert.deepEqual(classifyTap("ok 1 - fine\n"), { timeouts: [], failures: [] });
  });

  it("words a timeout differently from a failure in the runner summary", () => {
    const text = describeFailureKinds(classifyTap(TIMEOUT_TAP), 180000);
    assert.match(text, /timed out: slow one/);
    assert.match(text, /failed: broken one/);
    assert.match(text, /180000ms/);
    assert.equal(describeFailureKinds({ timeouts: [], failures: [] }, 1), "");
  });
});
