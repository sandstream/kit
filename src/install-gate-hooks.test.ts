import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { gitHookBypass } from "./install-gate-hooks.js";
import { decideBashGate } from "./install-gate.js";

// kit-research checks-in-harness-hooks-vs-kit: gate-bash passed all of these silently, and the
// `-c core.hooksPath` form left no skip record either.
const BYPASSES: Array<[string, string]> = [
  ["git commit --no-verify -m x", "git commit --no-verify"],
  ["git commit -n -m x", "git commit -n (--no-verify)"],
  ["git commit -anm x", "git commit -n (--no-verify)"],
  ["git push --no-verify", "git push --no-verify"],
  ["git push --no-ver", "git push --no-verify"],
  ["git merge --no-verify topic", "git merge --no-verify"],
  ["git -c core.hooksPath=/dev/null commit -m x", "git -c core.hooksPath"],
  ["git -c core.HooksPath=/tmp/none commit -m x", "git -c core.hooksPath"],
  ["git config core.hooksPath /dev/null", "git config core.hooksPath"],
  ["git config --global --unset core.hooksPath", "git config core.hooksPath"],
  ["HUSKY=0 git commit -m x", "HUSKY=0"],
  ["env HUSKY=0 git push", "HUSKY=0"],
  ["export HUSKY=0", "HUSKY=0"],
  ["HUSKY_SKIP_HOOKS=1 git commit -m x", "HUSKY_SKIP_HOOKS=1"],
  ["rm -rf .git/hooks", "rm on a git hook"],
  ["rm .husky/pre-commit", "rm on a git hook"],
  ["chmod -x .git/hooks/pre-commit", "chmod on a git hook"],
  ['sh -c "git commit --no-verify -m x"', "git commit --no-verify"],
  ["sudo -u bob git commit --no-verify", "git commit --no-verify"],
  ["git -C sub commit --no-verify", "git commit --no-verify"],
  ["npm test && git commit --no-verify -m ok", "git commit --no-verify"],
];

describe("install gate: commands that skip the git hooks", () => {
  for (const [command, named] of BYPASSES) {
    it(`names it: ${command}`, () => {
      assert.equal(gitHookBypass(command), named);
    });
  }

  for (const command of [
    "git commit -am x",
    'git commit -m "drop the -n flag"',
    "git commit -mn",
    "git commit -m x -- --no-verify",
    "git config --get core.hooksPath",
    "git log --no-verify",
    "git status",
    "echo HUSKY=0",
    "npm test && git commit -m ok",
    "rm -rf node_modules",
  ]) {
    it(`leaves an ordinary command alone: ${command}`, () => {
      assert.equal(gitHookBypass(command), null);
    });
  }

  it("blocks in the gate itself, before any registry request, and says who decides", async () => {
    const verdict = await decideBashGate("git commit --no-verify -m x");
    assert.equal(verdict.block, true);
    assert.match(verdict.reason, /skips the repository's git hooks \(git commit --no-verify\)/);
    assert.match(verdict.reason, /a person decides/);
    assert.deepEqual(verdict.checked, []);
  });

  it("does not block a commit that runs the hooks", async () => {
    assert.equal((await decideBashGate("git commit -m ok")).block, false);
  });
});
