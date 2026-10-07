import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { propagate } from "./secrets-propagate.js";
import { installFakeGh, withFakeGh } from "./fake-gh.test-support.js";

describe("fake gh test support", () => {
  it("catches a github propagation before it can reach the real CLI", async () => {
    const gh = installFakeGh();
    try {
      const [result] = await propagate("FAKE_GH_PROBE", "not-a-secret", ["github"]);
      assert.equal(result.ok, false);
      assert.deepEqual(gh.calls(), ["secret set FAKE_GH_PROBE"]);
    } finally {
      gh.restore();
    }
  });

  it("restores PATH after the wrapped call, including when it throws", async () => {
    const before = process.env.PATH;
    await assert.rejects(
      withFakeGh(async () => {
        assert.notEqual(process.env.PATH, before);
        throw new Error("boom");
      }),
      /boom/,
    );
    assert.equal(process.env.PATH, before);
  });
});
