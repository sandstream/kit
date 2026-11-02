import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { agentFromHarness, describeOwner, detectOwner, sameOwner } from "./owner.js";

describe("detectOwner", () => {
  it("reads the Claude Code session id", () => {
    const owner = detectOwner({ CLAUDE_CODE_SESSION_ID: "aaaa-1111", CLAUDECODE: "1" });
    assert.deepEqual(owner, { agent: "claude", session: "aaaa-1111" });
  });

  it("prefers Codex when both sets of variables are present", () => {
    const owner = detectOwner({
      CODEX_THREAD_ID: "cccc-3333",
      CLAUDE_CODE_SESSION_ID: "aaaa-1111",
    });
    assert.deepEqual(owner, { agent: "codex", session: "cccc-3333" });
  });

  it("falls back to CODEX_SESSION_ID when there is no thread id", () => {
    assert.equal(detectOwner({ CODEX_SESSION_ID: "dddd-4444" }).session, "dddd-4444");
  });

  it("names the agent without a session id when only the marker is set", () => {
    assert.deepEqual(detectOwner({ CLAUDECODE: "1" }), { agent: "claude" });
    assert.deepEqual(detectOwner({ CODEX_CI: "1" }), { agent: "codex" });
    assert.deepEqual(detectOwner({ CODEX_SANDBOX: "seatbelt" }), { agent: "codex" });
  });

  it("treats blank values as unset and keeps a trimmed label", () => {
    const owner = detectOwner({ CLAUDE_CODE_SESSION_ID: "  " }, "  dev  ");
    assert.deepEqual(owner, { agent: "unknown", label: "dev" });
  });
});

describe("sameOwner", () => {
  it("lets the session id decide when either side has one", () => {
    const a = { agent: "claude", session: "s1" } as const;
    assert.equal(sameOwner(a, { agent: "claude", session: "s1" }), true);
    assert.equal(sameOwner(a, { agent: "claude", session: "s2" }), false);
    assert.equal(sameOwner(a, { agent: "claude" }), false);
    assert.equal(sameOwner(a, { agent: "codex", session: "s1" }), false);
  });

  it("uses agent and label when neither side has a session", () => {
    const a = { agent: "unknown", label: "dev" } as const;
    assert.equal(sameOwner(a, { agent: "unknown", label: "dev" }), true);
    assert.equal(sameOwner(a, { agent: "unknown", label: "other" }), false);
    assert.equal(sameOwner(a, { agent: "unknown" }), false);
  });
});

describe("describeOwner and agentFromHarness", () => {
  it("shortens the session id and puts the label first", () => {
    assert.equal(describeOwner({ agent: "claude", session: "12345678abcdef" }), "claude:12345678");
    assert.equal(describeOwner({ agent: "unknown", label: "dev" }), "dev (unknown)");
  });

  it("maps a harness name to an agent kind", () => {
    assert.equal(agentFromHarness("codex"), "codex");
    assert.equal(agentFromHarness("claude"), "claude");
    assert.equal(agentFromHarness("other"), "unknown");
    assert.equal(agentFromHarness(undefined), "unknown");
  });
});
