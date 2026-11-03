import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const text = readFileSync(resolve(root, ".github/workflows/pr-hygiene.yml"), "utf8");

/** The shell of the one step that checks the PR text. */
function script(): string {
  const from = text.indexOf("run: |\n");
  assert.ok(from >= 0, "the workflow has no run block");
  return text
    .slice(from + "run: |\n".length)
    .split("\n")
    .map((l) => l.replace(/^ {10}/, ""))
    .join("\n");
}

/** A stand-in `gh` that answers `gh api … --jq …` with the title and body the test sets. */
function fakeGh(): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-pr-hygiene-"));
  const gh = join(dir, "gh");
  writeFileSync(gh, '#!/bin/sh\nprintf \'%s\\n%s\' "$PR_TITLE" "$PR_BODY"\n');
  chmodSync(gh, 0o755);
  return dir;
}

function check(env: Record<string, string>) {
  return spawnSync("sh", ["-c", script()], {
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
