/**
 * Codex `.rules` files are Starlark. kit reads `prefix_rule(...)` calls as text, never evaluates
 * them, and returns anything else as unparsed (kit-research `prismor-always-allowed-rules-vs-kit`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseCodexRules, showPattern } from "./codex-rules.js";

describe("parseCodexRules", () => {
  it("reads the rule the Codex TUI writes, with allow as the default decision", () => {
    const out = parseCodexRules(
      '# saved by codex\nprefix_rule(pattern=["git", "push"], decision="allow")\nprefix_rule(pattern=["bash"])\n',
    );
    assert.deepEqual(out, [
      { ok: true, rule: { pattern: [["git"], ["push"]], decision: "allow" } },
      { ok: true, rule: { pattern: [["bash"]], decision: "allow" } },
    ]);
  });

  it("reads a multi-line call with alternatives, a justification and examples", () => {
    const out = parseCodexRules(
      [
        "prefix_rule(",
        '    pattern = ["gh", ["pr", "issue"], "view"],',
        "    decision = 'forbidden',",
        '    justification = "read-only \\"view\\" only",',
        '    match = [["gh", "pr", "view", "1"]],',
        '    not_match = ["gh pr merge"],',
        ")",
      ].join("\n"),
    );
    assert.equal(out.length, 1);
    assert.ok(out[0].ok);
    if (out[0].ok) {
      assert.equal(out[0].rule.decision, "forbidden");
      assert.equal(showPattern(out[0].rule.pattern), "gh [pr|issue] view");
    }
  });

  it("returns anything it cannot read as unparsed, never drops it", () => {
    const cases = [
      'CMD = "bash"\nprefix_rule(pattern=[CMD])',
      'load("x.star", "y")',
      'prefix_rule(["bash"], decision="allow")',
      'prefix_rule(pattern=["ba" + "sh"])',
      'prefix_rule(pattern=["bash"], decision="maybe")',
      "prefix_rule(pattern=[])",
      'prefix_rule(pattern=["bash"], sandbox="off")',
      'prefix_rule(pattern=["""bash"""])',
      'prefix_rule(pattern=["bash"]) + 1',
    ];
    for (const text of cases) {
      const out = parseCodexRules(text);
      assert.ok(out.length > 0, text);
      assert.ok(
        out.some((s) => !s.ok),
        `expected an unparsed statement for: ${text}`,
      );
    }
  });

  it("does not split on a newline or # inside a string or a call", () => {
    const out = parseCodexRules('prefix_rule(\n pattern=["echo", "#not-a-comment"],\n)');
    assert.equal(out.length, 1);
    assert.ok(out[0].ok);
  });
});
