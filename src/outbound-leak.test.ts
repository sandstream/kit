import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SPAN_DISPLAY_MAX, displaySpan, findInstructionLeaks, normalise } from "./outbound-leak.js";

const PRIVATE = [
  "# Local notes",
  "",
  "Always route deploys through the staging bastion before touching production.",
  "The billing reconciler runs at 03:10 UTC and must never be restarted by hand.",
  "Ask the owner before rotating the partner webhook signing keys on Fridays.",
].join("\n");

describe("normalise", () => {
  it("lower-cases, drops markdown markers and collapses whitespace, keeping lines", () => {
    const n = normalise("**Never**  push\n\n`main`  directly");
    assert.equal(n.text, "never push main directly");
    assert.equal(n.lines[n.text.indexOf("main")], 3);
    assert.equal(n.text.length, n.lines.length);
  });
});

describe("findInstructionLeaks", () => {
  it("finds three private sentences repeated in a PR body, with file and line", () => {
    const body = `## Summary\nFixes the deploy.\n\n${PRIVATE.split("\n").slice(2).join(" ")}\n`;
    const findings = findInstructionLeaks(body, [{ shown: "CLAUDE.local.md", text: PRIVATE }], []);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.file, "CLAUDE.local.md");
    assert.equal(findings[0]!.line, 3);
    assert.equal(findings[0]!.endLine, 5);
    assert.ok(findings[0]!.chars > 200);
    assert.ok(findings[0]!.share > 0.8);
  });

  it("ignores text that a public instruction file also holds", () => {
    const body = PRIVATE.split("\n").slice(2).join("\n");
    const findings = findInstructionLeaks(
      body,
      [{ shown: "CLAUDE.local.md", text: PRIVATE }],
      [`# Public\n${body}\n`],
    );
    assert.deepEqual(findings, []);
  });

  it("reports only the private remainder when a span mixes public and private text", () => {
    const pub = "Always route deploys through the staging bastion before touching production.";
    const findings = findInstructionLeaks(PRIVATE, [{ shown: "p.md", text: PRIVATE }], [pub]);
    assert.ok(findings.length >= 1);
    assert.ok(findings.every((f) => !f.span.includes("bastion")));
  });

  it("does not report short common phrases", () => {
    const body = "Always route deploys. Ask the owner before rotating. Must never be restarted.";
    assert.deepEqual(findInstructionLeaks(body, [{ shown: "p.md", text: PRIVATE }], []), []);
  });

  it("raises the minimum when asked and never goes below the n-gram length", () => {
    const body = "the billing reconciler runs at 03:10 utc"; // 40 chars
    const privates = [{ shown: "p.md", text: PRIVATE }];
    assert.equal(findInstructionLeaks(body, privates, [], 40).length, 1);
    assert.equal(findInstructionLeaks(body, privates, [], 41).length, 0);
    assert.equal(findInstructionLeaks("billing", privates, [], 1).length, 0);
  });
});

describe("displaySpan", () => {
  it("caps the span and redacts a secret before capping", () => {
    assert.equal(displaySpan("x".repeat(500)).length, SPAN_DISPLAY_MAX);
    const shown = displaySpan(`token ghp_${"a".repeat(36)} here`);
    assert.ok(!shown.includes("a".repeat(36)), shown);
  });
});
