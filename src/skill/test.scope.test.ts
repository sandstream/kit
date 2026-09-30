// Scope-verdict wording tests for `checkScope`, kept out of `test.test.ts` deliberately.
//
// The standards gate ratchets function length against `.kit-baseline.json`, and lizard parses
// `test.test.ts` as one anonymous block that is already over the 80-line limit (baselined at
// ccn=1|length=241 and ccn=2|length=225). Any line added there grows a block that is already
// over, which the ratchet reports as a fresh finding — correctly. Moving a ratchet so a new test
// can land would weaken the gate to admit the change; adding the tests beside it does not. Hence
// a sibling file rather than an edit.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSkillManifest, checkScope, type SkillManifest } from "./test.js";

const withTools = (tools?: string): SkillManifest =>
  parseSkillManifest(`---
name: x
description: a description long enough to be valid
${tools === undefined ? "" : `allowed-tools: ${tools}`}
---
body`);

describe("checkScope — what the verdict may call bounded", () => {
  // A literal `*` fails while `Bash` passes — and Bash is the larger grant. Measured across every
  // tier for an `rm` reached through Bash: this check passes, `--runtime` returns undefined (no
  // extractable host), gate-fs passes non-write tool calls through, and gate-bash only blocks
  // un-triaged installs. The declaration is real, so the verdict stays a pass; the WORDING must
  // not call it bounded. Delete UNBOUNDABLE_TOOLS and the first two below go red.
  it("never calls a scope containing Bash bounded", () => {
    const r = checkScope(withTools("Bash"));
    assert.equal(r.status, "pass", "the declaration is real — this is not a failure");
    assert.doesNotMatch(r.detail, /bounded scope/, "Bash is the larger grant, not a bounded one");
    assert.match(r.detail, /cannot be bounded by any tier/);
    assert.match(r.detail, /Bash/);
  });

  it("names Bash even when it is one of several declared tools", () => {
    const r = checkScope(withTools("Read, Bash, Edit"));
    assert.equal(r.status, "pass");
    assert.match(r.detail, /3 tool\(s\)/);
    assert.doesNotMatch(r.detail, /bounded scope/);
  });

  it("still calls a genuinely bounded list bounded", () => {
    assert.match(checkScope(withTools("Read, Grep")).detail, /bounded scope/);
  });

  it("says nothing about unboundedness when no such tool is declared", () => {
    // The notice must not leak onto scopes it does not apply to.
    assert.doesNotMatch(checkScope(withTools("Read, Grep")).detail, /cannot be bounded/);
    assert.doesNotMatch(checkScope(withTools("")).detail, /cannot be bounded/);
  });
});
