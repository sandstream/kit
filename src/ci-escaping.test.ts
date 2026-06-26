import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { escapeWorkflowCmd, xmlEscape } from "./cli.js";

// Guards the CI-output injection fixes: attacker-controlled check
// category/name/detail must not be able to forge or hide GitHub workflow
// annotations or JUnit testcases.
describe("escapeWorkflowCmd (GitHub Actions workflow commands)", () => {
  it("escapes CR and LF so detail can't inject extra annotation lines", () => {
    const out = escapeWorkflowCmd("evil\n::error::forged\rtail");
    assert.equal(out, "evil%0A::error::forged%0Dtail");
    assert(!out.includes("\n"));
    assert(!out.includes("\r"));
  });

  it("escapes % first so encoded sequences aren't double-decoded", () => {
    // A literal "%" must become "%25", so an embedded "%0A" can't be re-decoded
    // into a newline downstream.
    assert.equal(escapeWorkflowCmd("a%0Ab"), "a%250Ab");
  });

  it("leaves benign text untouched", () => {
    assert.equal(escapeWorkflowCmd("tools/git: installed 2.40"), "tools/git: installed 2.40");
  });
});

describe("xmlEscape (JUnit XML)", () => {
  it("escapes quotes so detail can't break out of an attribute", () => {
    const out = xmlEscape(`x"/><testcase name="forged"/>`);
    assert(!out.includes('"'));
    assert(!out.includes("<"));
    assert(!out.includes(">"));
    assert.equal(out, "x&quot;/&gt;&lt;testcase name=&quot;forged&quot;/&gt;");
  });

  it("escapes & first to avoid double-encoding", () => {
    assert.equal(xmlEscape("a & <b>"), "a &amp; &lt;b&gt;");
  });

  it("leaves benign text untouched", () => {
    assert.equal(xmlEscape("not installed"), "not installed");
  });
});
