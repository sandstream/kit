import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deployListDetail } from "./check-deploy.js";

describe("the Vercel key listing failure", () => {
  it("says the time limit stopped it, instead of an empty reason", () => {
    const detail = deployListDetail({
      stdout: "",
      stderr: "",
      exitCode: 1,
      ok: false,
      timedOut: true,
    });
    assert.match(detail, /vercel env ls failed/);
    assert.match(detail, /time limit/);
  });

  it("keeps the first line of the tool's own error otherwise", () => {
    const detail = deployListDetail({
      stdout: "",
      stderr: "not logged in\nmore",
      exitCode: 1,
      ok: false,
    });
    assert.equal(detail, "vercel env ls failed: not logged in");
  });
});
