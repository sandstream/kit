import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sessionEndHarness } from "./memory-hook.js";

describe("sessionEndHarness", () => {
  it("names the harness of each SessionEnd hook event", () => {
    assert.equal(sessionEndHarness("session-end"), "claude-code");
    assert.equal(sessionEndHarness("session-end-codex"), "codex");
  });

  it("ignores every other hook event", () => {
    assert.equal(sessionEndHarness("session-end-run"), undefined);
    assert.equal(sessionEndHarness("user-prompt-submit"), undefined);
    assert.equal(sessionEndHarness(undefined), undefined);
  });
});
