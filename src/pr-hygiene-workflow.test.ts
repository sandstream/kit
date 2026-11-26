import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const text = readFileSync(resolve(root, ".github/workflows/pr-hygiene.yml"), "utf8");

/** The shell of the step named `name`: its `run: |` block, up to the next step. */
function stepScript(name: string): string {
  const at = text.indexOf(`- name: ${name}\n`);
  assert.ok(at >= 0, `the workflow has no step "${name}"`);
  const next = text.indexOf("\n      - name:", at + 1);
  const step = text.slice(at, next < 0 ? undefined : next);
  const from = step.indexOf("run: |\n");
  assert.ok(from >= 0, `step "${name}" has no run block`);
  return step
    .slice(from + "run: |\n".length)
    .split("\n")
    .map((l) => l.replace(/^ {10}/, ""))
    .join("\n");
}

/** The shell of the step that checks the PR text. */
const script = (): string => stepScript("Check the PR title and body as they are now");

/**
 * A stand-in `gh`: `gh api …/commits …` prints `PR_COMMITS` (the `sha message` lines its `--jq`
 * would print) or fails when `GH_FAIL` is set; any other call prints the title and body.
 */
function fakeGh(): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-pr-hygiene-"));
  const gh = join(dir, "gh");
  writeFileSync(
    gh,
    [
      "#!/bin/sh",
      'case "$*" in',
      '  *"/commits"*) [ -n "$GH_FAIL" ] && exit 1; printf \'%s\' "$PR_COMMITS" ;;',
      '  *) printf \'%s\\n%s\' "$PR_TITLE" "$PR_BODY" ;;',
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(gh, 0o755);
  return dir;
}

function check(env: Record<string, string>, body = script()) {
  return spawnSync("sh", ["-c", body], {
    env: { PATH: `${fakeGh()}${delimiter}${process.env.PATH ?? ""}`, REPO: "o/r", PR: "1", ...env },
    encoding: "utf8",
  });
}

const SESSION = "https://claude.ai/code/session_" + "01AbCdEfGhIjKlMnOpQrStUv";

// The check runs on a Linux runner in a POSIX shell, so the shell tests need one too.
const posix = { skip: process.platform === "win32" ? "needs a POSIX shell" : false };

describe("PR hygiene workflow", posix, () => {
  it("runs when a PR is opened, edited, reopened or pushed to", () => {
    for (const event of ["opened", "edited", "reopened", "synchronize"]) {
      assert.match(text, new RegExp(`\\b${event}\\b`), event);
    }
  });

  it("asks for no more than read access and checks out no code", () => {
    assert.match(text, /permissions:\s*\n\s+contents: read\n\s+pull-requests: read/);
    assert.doesNotMatch(text, /actions\/checkout/);
  });

  // A PR tool can add a session footer on creation that its caller replaces seconds later. The
  // event's snapshot then failed a PR whose text was already clean, so the check reads the text
  // as it is now, and waits on `opened` for that replacement.
  it("checks the PR text as it is now, not the event snapshot", () => {
    assert.doesNotMatch(text, /github\.event\.pull_request\.(body|title)/);
    assert.match(script(), /gh api "repos\/\$REPO\/pulls\/\$PR"/);
    assert.match(text, /if: github\.event\.action == 'opened'\n\s+run: sleep 30/);
  });

  it("never interpolates workflow expressions into the script", () => {
    assert.doesNotMatch(script(), /\$\{\{/);
  });

  it("accepts a clean PR text, including the generic footer", () => {
    const body =
      "Fixes a bug.\n\n\u{1F916} Generated with [Claude Code](https://claude.com/claude-code)";
    assert.equal(check({ PR_BODY: body, PR_TITLE: "fix: a bug" }).status, 0);
  });

  it("accepts an empty PR text", () => {
    assert.equal(check({ PR_BODY: "", PR_TITLE: "fix: a bug" }).status, 0);
  });

  it("rejects a session URL in the body and says how to fix it", () => {
    const r = check({ PR_BODY: `Summary\n\n${SESSION}`, PR_TITLE: "fix: a bug" });
    assert.equal(r.status, 1);
    assert.match(r.stdout + r.stderr, /session URL/i);
    assert.match(r.stdout + r.stderr, /Remove/);
  });

  it("rejects a session URL in the title", () => {
    const r = check({ PR_BODY: "ok", PR_TITLE: `fix ${SESSION}` });
    assert.equal(r.status, 1);
  });

  it("does not echo the URL it found", () => {
    const r = check({ PR_BODY: SESSION, PR_TITLE: "x" });
    assert.doesNotMatch(r.stdout + r.stderr, /session_01AbCd/);
  });
});

describe("PR hygiene workflow: commit messages", posix, () => {
  const commits = () => stepScript("Check the PR's commit messages");
  const run = (env: Record<string, string>) => check(env, commits());

  it("reads the PR's commits from the REST API, paginated, with no workflow expression", () => {
    assert.match(commits(), /gh api --paginate "repos\/\$REPO\/pulls\/\$PR\/commits/);
    assert.doesNotMatch(commits(), /\$\{\{/);
  });

  it("accepts commits without a session URL, including the co-author trailer", () => {
    const lines = "abc123def456 fix: a bug  Co-Authored-By: Claude <noreply@anthropic.com>";
    assert.equal(run({ PR_COMMITS: lines }).status, 0);
  });

  it("rejects a commit whose message holds a session URL and names it, not the URL", () => {
    const lines = `abc123def456 fix: a bug\n0123456789ab feat: x  Claude-Session: ${SESSION}`;
    const r = run({ PR_COMMITS: lines });
    assert.equal(r.status, 1);
    assert.match(r.stdout + r.stderr, /0123456789ab/);
    assert.doesNotMatch(r.stdout + r.stderr, /abc123def456/);
    assert.doesNotMatch(r.stdout + r.stderr, /session_01AbCd/);
  });

  it("fails when the commits cannot be read, instead of passing unchecked", () => {
    const r = run({ PR_COMMITS: "", GH_FAIL: "1" });
    assert.equal(r.status, 1);
    assert.match(r.stdout + r.stderr, /not checked/);
  });
});
