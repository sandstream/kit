import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { explainUnverifiable } from "./install-gate-refusals.js";

describe("install-gate refusal wording", () => {
  it("names a wrapper option the gate cannot read and says what to do", () => {
    const text = explainUnverifiable(["wrapper-option:-S"]);
    assert.match(
      text ?? "",
      /^UNVERIFIED COMMAND: wrapper-option:-S\. Use explicit command arguments/,
    );
  });

  it("names a source configuration and does not suggest triage as the fix", () => {
    const text = explainUnverifiable(["alt-registry:--config"]) ?? "";
    assert.match(
      text,
      /^UNVERIFIED SOURCE: alt-registry:--config\. Remove the source configuration/,
    );
    assert.match(text, /Package triage does not verify the unread configuration/);
  });

  it("explains command substitution as the hazard", () => {
    assert.match(explainUnverifiable(["indirect-bin:$(x)"]) ?? "", /COMMAND SUBSTITUTION/);
    assert.match(
      explainUnverifiable(["indirect-bin:`x`"]) ?? "",
      /backticks substitute inside double quotes/,
    );
  });

  it("has nothing to say about an ordinary token", () => {
    assert.equal(explainUnverifiable(["zzz"]), null);
  });
});
