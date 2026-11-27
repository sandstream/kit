/**
 * Where each harness keeps its saved rules, per OS: the managed and system paths come from each
 * vendor's documentation (kit-research `prismor-always-allowed-rules-vs-kit`). kit runs on Linux,
 * macOS and Windows, so each path is checked for all three, not only the one CI runs on.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { claudeManagedDir, geminiSystemFiles } from "./agent-rule-sources.js";

describe("managed and system paths per OS", () => {
  it("uses each vendor's documented directory", () => {
    assert.equal(claudeManagedDir("linux", {}), "/etc/claude-code");
    assert.equal(claudeManagedDir("darwin", {}), "/Library/Application Support/ClaudeCode");
    assert.equal(claudeManagedDir("win32", {}), "C:\\Program Files\\ClaudeCode");
    assert.equal(claudeManagedDir("win32", { ProgramFiles: "D:\\PF" }), "D:\\PF\\ClaudeCode");
    assert.deepEqual(geminiSystemFiles("win32"), [
      "C:\\ProgramData\\gemini-cli\\system-defaults.json",
      "C:\\ProgramData\\gemini-cli\\settings.json",
    ]);
  });
});
