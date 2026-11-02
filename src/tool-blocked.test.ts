import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { blockedByTriageNote } from "./tool-blocked.js";

describe("blockedByTriageNote", () => {
  it("explains a missing tool that has no backend prefix", () => {
    const note = blockedByTriageNote("some-bare-tool-xyz", null);
    assert.match(note ?? "", /no backend prefix/);
    assert.match(note ?? "", /pipx:some-bare-tool-xyz/);
  });

  it("says nothing about a tool that is installed", () => {
    assert.equal(blockedByTriageNote("some-bare-tool-xyz", "1.2.3"), undefined);
  });

  it("says nothing about a missing tool the install gate can triage", () => {
    assert.equal(blockedByTriageNote("pipx:semgrep", null), undefined);
    assert.equal(blockedByTriageNote("npm:left-pad", null), undefined);
  });
});
