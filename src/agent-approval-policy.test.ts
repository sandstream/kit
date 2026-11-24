/**
 * kit-research claude-ship-vs-kit: with one required approval, kit's required-reviews row passed,
 * although a Claude Approvals policy can let Claude post that one approval.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentApprovers, approvingLines, describeApprovers } from "./agent-approval-policy.js";
import { reviewRequirement } from "./branch-review-rules.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const CLAUDE = {
  approves: /\bclaude\s*:\s*["']?approves\b/,
  observe: /^mode\s*:\s*["']?observe\b/,
};
const POLICY = [
  "version: 1",
  "rules:",
  '  - purpose: "Docs need no person"',
  '    paths: ["docs/**"]',
  "    verdict: { claude: approves, seats: 0 }",
  '  - purpose: "Everything else takes two people"',
  '    paths: ["**"]',
  "    verdict: { claude: comments, seats: 2 }",
  "    override:",
  '      - { if: "claude/code_review = pass", verdict: { claude: approves, seats: 1 } }',
  "",
].join("\n");

describe("approvingLines", () => {
  it("finds every verdict that lets Claude approve, in flow and block style", () => {
    assert.deepEqual(approvingLines(POLICY, CLAUDE), [5, 10]);
    assert.deepEqual(approvingLines("rules:\n  - verdict:\n      claude: approves\n", CLAUDE), [3]);
  });

  it("reports nothing for a policy in observe mode, comments, or other verdicts", () => {
    assert.deepEqual(approvingLines(`mode: observe\n${POLICY}`, CLAUDE), []);
    assert.deepEqual(
      approvingLines("# claude: approves\nverdict: { claude: blocks }\n", CLAUDE),
      [],
    );
  });
});

describe("agentApprovers", () => {
  it("reads tracked policy files in the root and in subdirectories", (t) => {
    const root = mkdtempSync(join(tmpdir(), "kit-agent-approvers-"));
    t.after(() => rmTemp(root));
    mkdirSync(join(root, ".claude"));
    mkdirSync(join(root, "svc", ".claude"), { recursive: true });
    writeFileSync(join(root, ".claude", "approvals.yml"), POLICY);
    writeFileSync(join(root, "svc", ".claude", "approvals.yaml"), `mode: observe\n${POLICY}`);
    writeFileSync(join(root, "untracked.yml"), POLICY);
    execFileSync("git", ["init", "-q", root]);
    execFileSync("git", ["-C", root, "add", ".claude", "svc"]);
    assert.deepEqual(agentApprovers(root), [
      { tool: "Claude Approvals", file: ".claude/approvals.yml", lines: [5, 10] },
    ]);
  });

  it("returns nothing outside a git repository", (t) => {
    const root = mkdtempSync(join(tmpdir(), "kit-agent-approvers-nogit-"));
    t.after(() => rmTemp(root));
    assert.deepEqual(agentApprovers(root), []);
  });
});

describe("the required-reviews row with an agent that approves", () => {
  const agents = [{ tool: "Claude Approvals", file: ".claude/approvals.yml", lines: [5, 10] }];

  it("warns when the one required approval can be the agent's", () => {
    const r = reviewRequirement("main", 1, null, agents);
    assert.equal(r.status, "warn");
    assert.equal(
      r.detail,
      "main: 1 approval required, and an agent can give it: Claude Approvals (.claude/approvals.yml lines 5, 10). GitHub counts that approval, so a change on those paths can merge with no person approving",
    );
  });

  it("passes with two required, naming the agent, and is unchanged without one", () => {
    const two = reviewRequirement("main", 2, null, agents);
    assert.equal(two.status, "pass");
    assert.match(two.detail ?? "", /one of them can be an agent's: Claude Approvals/);
    assert.equal(reviewRequirement("main", 1, null).status, "pass");
    assert.equal(reviewRequirement("main", 0, null, agents).status, "warn");
  });

  it("names at most three files", () => {
    const many = [1, 2, 3, 4].map((n) => ({
      tool: "Claude Approvals",
      file: `${n}/.claude/approvals.yml`,
      lines: [n],
    }));
    assert.match(describeApprovers(many), /and 1 more file\(s\)$/);
  });
});
