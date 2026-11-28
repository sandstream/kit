/**
 * `kit triage prompt` names the repository behind `owner/repo` agent installers, as it names a
 * `git clone` (kit-research copybook-vs-kit: none of the three below listed a target).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderPromptTriage, triagePrompt } from "./triage-prompt.js";

const report = (text: string) => renderPromptTriage(triagePrompt(text)).join("\n");

describe("triagePrompt: repositories added by agent installers", () => {
  for (const installer of [
    "claude plugin marketplace add",
    "codex plugin marketplace add",
    "npx skills add",
    "npx -y skills@latest add",
  ]) {
    it(`lists the repo of \`${installer} owner/repo\` as a source to triage`, () => {
      const t = triagePrompt(`Install it:\n\n    ${installer} Owner/copy-skills\n`);
      assert.deepEqual(
        t.repoInstalls.map((r) => r.ownerRepo),
        ["Owner/copy-skills"],
      );
      const out = report(`Run \`${installer} Owner/copy-skills\`.`);
      assert.match(out, /repo Owner\/copy-skills/);
      assert.ok(out.includes("`kit triage repo Owner/copy-skills`"), out);
    });
  }

  it("reads GitHub URL sources, skips flag values and ignores local paths", () => {
    const t = triagePrompt(
      [
        "codex plugin marketplace add --ref main https://github.com/a/b.git",
        "codex plugin marketplace add ./local-marketplace-root",
        "claude plugins marketplace add 'c/d'",
      ].join("\n"),
    );
    assert.deepEqual(
      t.repoInstalls.map((r) => r.ownerRepo),
      ["a/b", "c/d"],
    );
    // The repository URL is the repo, not an instruction file to fetch.
    assert.doesNotMatch(report("codex plugin marketplace add https://github.com/a/b"), /<fetched/);
  });

  it("says a source on another host cannot be scored as a GitHub repo", () => {
    const out = report("claude plugin marketplace add https://gitlab.com/a/b");
    assert.match(out, /https:\/\/gitlab\.com\/a\/b: not a GitHub repository/);
  });

  it("does not read installers it does not name, or prose about them", () => {
    assert.deepEqual(triagePrompt("codex plugin marketplace upgrade copybook").repoInstalls, []);
    assert.deepEqual(triagePrompt("npx skills list").repoInstalls, []);
  });
});
