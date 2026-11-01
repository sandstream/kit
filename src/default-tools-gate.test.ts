import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkTools } from "./check-tools.js";
import { triageTargetFor } from "./triage-gate.js";
import { DEFAULT_SECURITY_SCANNERS } from "./toml-generator.js";

describe("default tools and the install gate", () => {
  it("every default security scanner maps to a triage target", () => {
    for (const ref of Object.keys(DEFAULT_SECURITY_SCANNERS)) {
      assert.notEqual(triageTargetFor(ref).kind, "untriageable", `${ref} would be refused`);
    }
  });

  it("says why a missing tool without a backend prefix is not installed", async () => {
    const none = async () => null;
    const [bare, prefixed] = await checkTools(
      { "not-a-core-runtime-xyz": "latest", "pipx:not-a-real-pkg-xyz": "latest" },
      none,
    );
    assert.match(bare.blockedByTriage ?? "", /backend prefix/);
    assert.equal(prefixed.blockedByTriage, undefined);
  });
});
