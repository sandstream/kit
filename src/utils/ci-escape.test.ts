import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { escapeWorkflowCmd, xmlEscape } from "./ci-escape.js";

// These two escapers are the only thing standing between a config-controlled string and
// a forged CI annotation or a forged JUnit testcase — the hole kit's own R7 self-audit
// rule exists to prevent. They had no tests. Ordering is the subtle part in both: the
// escape character itself must go first, or the escaper re-escapes its own output.

describe("escapeWorkflowCmd", () => {
  it("leaves ordinary text untouched", () => {
    assert.equal(escapeWorkflowCmd("secrets scan passed"), "secrets scan passed");
  });

  it("escapes CR and LF so a detail string cannot forge another annotation", () => {
    // The attack: a finding detail containing a newline plus `::error::` would emit a
    // second annotation the scanner never produced.
    assert.equal(
      escapeWorkflowCmd("clean\n::error::fake failure"),
      "clean%0A::error::fake failure",
    );
    assert.equal(escapeWorkflowCmd("a\rb"), "a%0Db");
    assert.equal(escapeWorkflowCmd("a\r\nb"), "a%0D%0Ab");
  });

  it("escapes every occurrence, not just the first", () => {
    assert.equal(escapeWorkflowCmd("a\nb\nc"), "a%0Ab%0Ac");
  });

  it("escapes `%` FIRST so an escape sequence cannot be smuggled in literally", () => {
    // If `%` were escaped last, the literal input `%0A` would survive as `%0A` and be
    // decoded by the runner as a newline — the exact forgery the CR/LF escaping stops.
    assert.equal(escapeWorkflowCmd("%0A"), "%250A");
    assert.equal(escapeWorkflowCmd("100%"), "100%25");
  });

  it("is idempotent-safe in the sense that double-escaping is visible, not exploitable", () => {
    assert.equal(escapeWorkflowCmd(escapeWorkflowCmd("a\nb")), "a%250Ab");
  });

  it("coerces a non-string rather than throwing", () => {
    assert.equal(escapeWorkflowCmd(42 as unknown as string), "42");
    assert.equal(escapeWorkflowCmd(null as unknown as string), "null");
    assert.equal(escapeWorkflowCmd(undefined as unknown as string), "undefined");
  });

  it("handles the empty string", () => {
    assert.equal(escapeWorkflowCmd(""), "");
  });
});

describe("xmlEscape", () => {
  it("leaves ordinary text untouched", () => {
    assert.equal(xmlEscape("license check"), "license check");
  });

  it("escapes the characters that could close an attribute or element", () => {
    assert.equal(xmlEscape("<"), "&lt;");
    assert.equal(xmlEscape(">"), "&gt;");
    assert.equal(xmlEscape('"'), "&quot;");
    assert.equal(xmlEscape("&"), "&amp;");
  });

  it("neutralises a forged testcase element", () => {
    // The attack: a finding name that closes the current element and opens a passing
    // one, deleting a real failure from the report.
    assert.equal(
      xmlEscape('x"/></testcase><testcase name="fake'),
      "x&quot;/&gt;&lt;/testcase&gt;&lt;testcase name=&quot;fake",
    );
  });

  it("escapes `&` FIRST so an entity cannot be smuggled in literally", () => {
    // If `&` were escaped last, the input `&lt;` would survive intact and the XML
    // reader would decode it back to `<`.
    assert.equal(xmlEscape("&lt;"), "&amp;lt;");
    assert.equal(xmlEscape("&amp;"), "&amp;amp;");
  });

  it("escapes every occurrence", () => {
    assert.equal(xmlEscape("<a><b>"), "&lt;a&gt;&lt;b&gt;");
  });

  it("coerces a non-string rather than throwing", () => {
    assert.equal(xmlEscape(0 as unknown as string), "0");
    assert.equal(xmlEscape(null as unknown as string), "null");
  });

  it("handles the empty string", () => {
    assert.equal(xmlEscape(""), "");
  });

  it("does not escape a single quote — documented, since attributes here use double quotes", () => {
    // Pinned deliberately: if an emitter ever switches to single-quoted attributes this
    // test is the thing that has to change, rather than a silent hole opening.
    assert.equal(xmlEscape("it's"), "it's");
  });
});
