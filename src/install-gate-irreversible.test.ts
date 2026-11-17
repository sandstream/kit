import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { irreversibleCommand } from "./install-gate-irreversible.js";
import { decideBashGate } from "./install-gate.js";

// The owner chose the strict option: gate-bash passed every one of these with exit 0.
const BLOCKED: Array<[string, string, string]> = [
  // force push, and a push to the default branch
  ["git push --force", "force push", "git push --force"],
  ["git push -f origin feature", "force push", "git push --force"],
  ["git push -uf origin feature", "force push", "git push --force"],
  ["git push --force-with-lease origin feature", "force push", "git push --force-with-lease"],
  [
    "git push --force-with-lease=feature:abc origin feature",
    "force push",
    "git push --force-with-lease",
  ],
  ["git push --mirror backup", "force push", "git push --mirror"],
  ["git push origin +feature", "force push", "git push +feature"],
  ["git push origin feature --force", "force push", "git push --force"],
  ["git push origin main", "push to the default branch", "git push to main"],
  ["git push origin master", "push to the default branch", "git push to master"],
  ["git push origin HEAD:main", "push to the default branch", "git push to main"],
  ["git push origin HEAD:refs/heads/main", "push to the default branch", "git push to main"],
  ["git -C sub push origin main", "push to the default branch", "git push to main"],
  // discarding work
  ["git reset --hard", "discards uncommitted work", "git reset --hard"],
  ["git reset --hard origin/main", "discards uncommitted work", "git reset --hard"],
  ["git clean -fdx", "deletes untracked files", "git clean -f"],
  ["git clean -d -f", "deletes untracked files", "git clean -f"],
  ["git clean --force", "deletes untracked files", "git clean -f"],
  ["git stash drop", "deletes stashed work", "git stash drop"],
  ["git stash drop stash@{1}", "deletes stashed work", "git stash drop"],
  ["git stash clear", "deletes stashed work", "git stash clear"],
  ["git checkout -- .", "discards uncommitted work", "git checkout -- ."],
  ["git checkout .", "discards uncommitted work", "git checkout -- ."],
  ["git checkout -f main", "discards uncommitted work", "git checkout --force"],
  ["git restore .", "discards uncommitted work", "git restore ."],
  ["git restore --worktree --staged .", "discards uncommitted work", "git restore ."],
  [
    "git switch --discard-changes main",
    "discards uncommitted work",
    "git switch --discard-changes",
  ],
  ["git branch -D feature", "deletes an unmerged branch", "git branch -D"],
  [
    "git branch --delete --force feature",
    "deletes an unmerged branch",
    "git branch --delete --force",
  ],
  // recursive deletes of what cannot be rebuilt
  ["rm -rf .git", "recursive delete of what cannot be rebuilt", "rm -r .git"],
  ["rm -rf ./.git/", "recursive delete of what cannot be rebuilt", "rm -r ./.git/"],
  ["rm -rf /", "recursive delete of what cannot be rebuilt", "rm -r /"],
  ["rm -r ~", "recursive delete of what cannot be rebuilt", "rm -r ~"],
  ['rm -rf "$HOME"', "recursive delete of what cannot be rebuilt", "rm -r $HOME"],
  ["rm -rf ..", "recursive delete of what cannot be rebuilt", "rm -r .."],
  ["rm -rf .", "recursive delete of what cannot be rebuilt", "rm -r ."],
  ["rm -Rf dist .", "recursive delete of what cannot be rebuilt", "rm -r ."],
  ["rm --recursive --force ../", "recursive delete of what cannot be rebuilt", "rm -r ../"],
  [
    "Remove-Item -Recurse -Force .git",
    "recursive delete of what cannot be rebuilt",
    "Remove-Item -Recurse .git",
  ],
  ["rmdir /s /q .git", "recursive delete of what cannot be rebuilt", "Remove-Item -Recurse .git"],
  // production deploys and publishes
  ["vercel --prod", "production deploy", "vercel --prod"],
  ["vercel deploy --prod", "production deploy", "vercel --prod"],
  ["npx vercel@latest --prod", "production deploy", "vercel --prod"],
  ["fly deploy", "production deploy", "fly deploy"],
  ["flyctl deploy --remote-only", "production deploy", "flyctl deploy"],
  ["netlify deploy --prod", "production deploy", "netlify deploy --prod"],
  ["wrangler deploy", "production deploy", "wrangler deploy"],
  ["wrangler publish", "production deploy", "wrangler publish"],
  ["railway up", "production deploy", "railway up"],
  ["firebase deploy --only hosting", "production deploy", "firebase deploy"],
  ["npm publish", "package publish", "npm publish"],
  ["npm publish --access public", "package publish", "npm publish"],
  ["pnpm publish", "package publish", "pnpm publish"],
  ["yarn npm publish", "package publish", "yarn publish"],
  ["pnpm dlx vercel --prod", "production deploy", "vercel --prod"],
  // carriers
  ['sh -c "git push --force"', "force push", "git push --force"],
  ["bash -lc 'git reset --hard'", "discards uncommitted work", "git reset --hard"],
  ["sudo rm -rf /", "recursive delete of what cannot be rebuilt", "rm -r /"],
  ["env CI=1 npm publish", "package publish", "npm publish"],
  ["CI=1 npm publish", "package publish", "npm publish"],
  ["npm test && git push origin main", "push to the default branch", "git push to main"],
  ["(cd sub && git push -f)", "force push", "git push --force"],
  [
    'powershell -c "Remove-Item -Recurse -Force .git"',
    "recursive delete of what cannot be rebuilt",
    "Remove-Item -Recurse .git",
  ],
  [
    "cmd /c rmdir /s /q .git",
    "recursive delete of what cannot be rebuilt",
    "Remove-Item -Recurse .git",
  ],
  ['echo "$(git stash clear)"', "deletes stashed work", "git stash clear"],
];

const ALLOWED = [
  "git push origin some-feature-branch",
  "git push -u origin claude/web-kit-status-sync",
  "git push",
  "git push origin HEAD",
  "git push origin main:feature",
  "git push --follow-tags origin feature",
  "git reset HEAD~1",
  "git reset --soft HEAD~1",
  "git clean -n",
  "git clean -nd",
  "git stash",
  "git stash pop",
  "git stash list",
  "git checkout feature",
  "git checkout -b feature",
  "git checkout -- src/file.ts",
  "git restore src/file.ts",
  "git restore --staged .",
  "git switch -c feature",
  "git branch -d feature",
  "git status",
  "git log --oneline main",
  "rm -rf dist node_modules build .next coverage",
  "rm -rf ./dist/",
  "rm -f .gitignore.bak",
  "rm .",
  "Remove-Item -Recurse -Force dist",
  "vercel",
  "vercel deploy",
  "netlify deploy",
  "wrangler deploy --dry-run",
  "npm publish --dry-run",
  "npm pack",
  "npm run build",
  "firebase hosting:channel:deploy preview",
  'echo "git push --force"',
  "grep -rn 'rm -rf' src",
  'git commit -m "never run git reset --hard"',
  "printf '%s\\n' 'npm publish'",
];

describe("install gate: commands that cannot be undone", () => {
  for (const [command, kind, named] of BLOCKED) {
    it(`refuses: ${command}`, () => {
      assert.deepEqual(irreversibleCommand(command), { kind, named });
    });
  }

  for (const command of ALLOWED) {
    it(`allows: ${JSON.stringify(command)}`, () => {
      assert.equal(irreversibleCommand(command), null);
    });
  }

  it("blocks in the gate itself, names the class and asks for the person", async () => {
    const verdict = await decideBashGate("git push --force origin feature");
    assert.equal(verdict.block, true);
    assert.match(verdict.reason, /cannot be undone: force push \(git push --force\)/);
    assert.match(verdict.reason, /Ask the person to run it/);
    assert.deepEqual(verdict.checked, []);
  });

  it("the gate passes a feature-branch push and a here-document body that is data", async () => {
    assert.equal((await decideBashGate("git push -u origin feature")).block, false);
    const heredoc = "cat <<'EOF' > notes.md\nrm -rf /\nEOF";
    assert.equal((await decideBashGate(heredoc)).block, false);
  });

  it("the gate still reads a here-document a shell runs", async () => {
    const verdict = await decideBashGate("bash <<'EOF'\ngit reset --hard\nEOF");
    assert.equal(verdict.block, true);
    assert.match(verdict.reason, /git reset --hard/);
  });
});
