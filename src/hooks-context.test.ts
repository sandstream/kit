import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hooksContextNote } from "./hooks-context.js";
import type { HookCheckResult } from "./check-hooks.js";

const ok: HookCheckResult = {
  hookName: "pre-commit",
  installed: true,
  executable: true,
  upToDate: true,
  detail: "up-to-date",
};

describe("hooksContextNote", () => {
  it("says nothing when every declared hook would run", () => {
    assert.equal(hooksContextNote([ok, { ...ok, hookName: "pre-push" }]), null);
    assert.equal(hooksContextNote([]), null);
  });

  it("names each hook that does not run, why, and the command that fixes it, in plain text", () => {
    const note = hooksContextNote([
      { ...ok, installed: false, executable: false, upToDate: false },
      { ...ok, hookName: "pre-push", executable: false },
      { ...ok, hookName: "post-merge", upToDate: false },
      { ...ok, hookName: "commit-msg" },
    ]);
    assert.ok(note);
    assert.match(
      note,
      /pre-commit \(not installed\), pre-push \(not executable\), post-merge \(outdated\)/,
    );
    assert.equal(note.includes("commit-msg"), false);
    assert.match(note, /`kit hooks install`/);
    assert.equal(note.includes("\u001b["), false, "no colour codes in agent context");
  });
});
