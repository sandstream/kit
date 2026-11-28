import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decideBashGate } from "./install-gate.js";
import { ghTokenAction, ghTokenRefusal } from "./gh-token-actions.js";

// kit-research agent-vm-yolo-herdr-paseo-vs-kit: gate-bash refused `git push origin main` but
// passed every one of these with exit 0.
const REFUSED: Array<[string, RegExp, string]> = [
  ["gh pr merge 12 --admin --squash", /merges into the base branch/, "gh pr merge --admin"],
  ["gh pr merge 12 --squash", /merges into the base branch/, "gh pr merge"],
  ["gh pr merge --auto --merge", /merges into the base branch/, "gh pr merge"],
  ["gh pr -R o/r merge 3", /merges into the base branch/, "gh pr merge"],
  [
    "gh api -X PUT repos/o/r/pulls/12/merge",
    /merges into the base branch/,
    "gh api -X PUT repos/o/r/pulls/12/merge",
  ],
  [
    "gh api --method=put /repos/{owner}/{repo}/pulls/12/merge/",
    /merges into the base branch/,
    "gh api -X PUT repos/{owner}/{repo}/pulls/12/merge",
  ],
  [
    "gh api repos/o/r/pulls/12/merge -f merge_method=squash",
    /merges into the base branch/,
    "gh api -X POST repos/o/r/pulls/12/merge",
  ],
  [
    "gh api https://api.github.com/repos/o/r/merges -f base=main -f head=x",
    /merges into the base branch/,
    "gh api -X POST repos/o/r/merges",
  ],
  [
    `gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: "x"}) { clientMutationId } }'`,
    /merges into the base branch/,
    "gh api graphql (merge)",
  ],
  [
    "gh api -XPUT repos/o/r/pulls/12/ccr/auto_merge",
    /merges into the base branch/,
    "gh api -X PUT repos/o/r/pulls/12/ccr/auto_merge",
  ],
  [
    "gh api --method Put repos/o/r/pulls/12/merge",
    /merges into the base branch/,
    "gh api -X PUT repos/o/r/pulls/12/merge",
  ],
  ["gh secret set NPM_TOKEN --body x", /changes a secret/, "gh secret set"],
  ["gh secret delete NPM_TOKEN", /changes a secret/, "gh secret delete"],
  [
    "gh api -X PUT repos/o/r/actions/secrets/NPM_TOKEN --input body.json",
    /changes a secret/,
    "gh api -X PUT repos/o/r/actions/secrets/NPM_TOKEN",
  ],
  ["gh variable set FOO --body bar", /changes a configuration variable/, "gh variable set"],
  ["gh workflow run publish.yml -f tag=v1", /runs or switches a workflow/, "gh workflow run"],
  ["gh workflow enable ci.yml", /runs or switches a workflow/, "gh workflow enable"],
  ["gh workflow disable ci.yml", /runs or switches a workflow/, "gh workflow disable"],
  [
    "gh api repos/o/r/actions/workflows/publish.yml/dispatches -f ref=main",
    /runs or switches a workflow/,
    "gh api -X POST repos/o/r/actions/workflows/publish.yml/dispatches",
  ],
  ["gh auth token", /reads or replaces the GitHub token/, "gh auth token"],
  ["gh auth status --show-token", /reads or replaces/, "gh auth status --show-token"],
  ["gh auth refresh -s admin:org", /reads or replaces/, "gh auth refresh"],
  ["gh auth login --with-token < t.txt", /reads or replaces/, "gh auth login"],
  ["gh alias set mm 'pr merge --admin'", /merges into the base branch/, "gh pr merge --admin"],
  ["gh alias set tk --shell 'gh auth token'", /reads or replaces/, "gh auth token"],
];

// The carriers the nested-agent classifier reads, shared through gate-bash-carriers.
const CARRIED = [
  "sh -c 'gh pr merge 1 --admin'",
  'bash -lc "gh secret set X --body y"',
  "env GH_TOKEN=x gh workflow run ci.yml",
  "sudo -u bob /usr/bin/gh auth token",
  "GH_HOST=github.com gh pr merge 1",
  "npx -y gh pr merge 1",
  "echo $(gh auth token)",
  "echo `gh auth token`",
  'cmd /c "gh pr merge 1 --admin"',
  'powershell -Command "gh auth token"',
  `pwsh -EncodedCommand ${Buffer.from("gh pr merge 1", "utf16le").toString("base64")}`,
  "npm test && gh.exe pr merge 1",
  "command gh pr merge 1",
  "exec gh auth token",
  "/opt/homebrew/bin/gh pr merge 1",
  '"C:\\Program Files\\GitHub CLI\\gh.exe" secret set X',
  '"gh" pr "merge" 1',
  "g'h' pr me''rge 1",
  "\\gh auth token",
  "xargs gh pr merge < prs.txt",
];

const ALLOWED = [
  "gh api repos/o/r/pulls/12",
  "gh api repos/o/r/pulls/12/merge",
  "gh api repos/o/r/pulls/12/ccr/auto_merge",
  "gh api -X GET repos/o/r/actions/secrets",
  "gh api graphql -f query='{ viewer { login } }'",
  "gh api repos/o/r/issues/1/comments -f body='merge with gh pr merge --admin later'",
  "gh pr view 12",
  "gh pr list --state open",
  "gh pr checks 12",
  "gh pr create --title t --body 'run gh pr merge after review'",
  "gh run view 123 --log-failed",
  "gh secret list",
  "gh variable list",
  "gh workflow view ci.yml",
  "gh auth status",
  "echo gh pr merge 1 --admin",
  "git commit -m 'gh auth token'",
];

describe("GitHub token actions: the classifier", () => {
  for (const [command, kind, named] of REFUSED) {
    it(`names it: ${command}`, () => {
      const found = ghTokenAction(command);
      assert.match(found?.kind ?? "", kind);
      assert.equal(found?.named, named);
    });
  }
  for (const command of CARRIED) {
    it(`reads through the carrier: ${command}`, () => {
      assert.ok(ghTokenAction(command), command);
    });
  }
  for (const command of ALLOWED) {
    it(`leaves it alone: ${command}`, () => {
      assert.equal(ghTokenRefusal({ command, expansions: [] }), null);
    });
  }
  it("takes one argv", () => {
    assert.equal(ghTokenAction(["gh", "pr", "merge", "--admin"])?.named, "gh pr merge --admin");
    assert.equal(ghTokenAction(["gh", "pr", "view"]), null);
  });
});

describe("GitHub token actions: gate-bash", () => {
  it("refuses before any registry request and asks for the person", async () => {
    const verdict = await decideBashGate("gh pr merge 12 --admin --squash");
    assert.equal(verdict.block, true);
    assert.match(verdict.reason, /merges into the base branch \(gh pr merge --admin\)/);
    assert.match(verdict.reason, /Hand it to the person/);
    assert.deepEqual(verdict.checked, []);
  });
  it("allows the reads and the hand-over", async () => {
    for (const command of ["gh pr view 12", "gh pr create --fill", "gh run view 1"])
      assert.equal((await decideBashGate(command)).block, false, command);
  });
  it("does not read a quoted here-document body as a command", async () => {
    const verdict = await decideBashGate("cat <<'EOF'\ngh pr merge 1 --admin\nEOF");
    assert.equal(verdict.block, false);
  });
});

const CLI_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "cli.js");
// Claude Code and Codex both route their Bash tool to `kit gate-bash` with this payload shape.
const PAYLOADS: Record<string, (command: string) => unknown> = {
  "Claude Code": (command) => ({ tool_name: "Bash", tool_input: { command } }),
  Codex: (command) => ({
    session_id: "s",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
  }),
};

function gateBash(payload: unknown): { status: number | null; stderr: string } {
  const r = spawnSync(process.execPath, [CLI_PATH, "gate-bash"], {
    input: JSON.stringify(payload),
    encoding: "utf-8",
    env: { ...process.env, KIT_HIDE_HOOK_SKIP_BANNER: "1", KIT_AUDIT_ANCHOR: "0" },
    timeout: 60_000,
  });
  return { status: r.status, stderr: r.stderr ?? "" };
}

describe("GitHub token actions: compiled gate-bash, per harness", () => {
  for (const [harness, payload] of Object.entries(PAYLOADS)) {
    it(`${harness}: exit 2 on gh auth token, exit 0 on gh pr view`, () => {
      const refused = gateBash(payload("gh auth token"));
      assert.equal(refused.status, 2, refused.stderr);
      assert.match(refused.stderr, /reads or replaces the GitHub token \(gh auth token\)/);
      assert.match(refused.stderr, /Hand it to the person/);
      assert.doesNotMatch(refused.stderr, /Triage it first/);
      assert.equal(gateBash(payload("gh pr view 1")).status, 0);
    });
  }
});
