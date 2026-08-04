import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * docs/VERIFY.md ↔ real CLI usage gate.
 *
 * VERIFY.md is the one document whose whole job is to be RUN, by someone who
 * does not trust us yet. It shipped this, in the copy-pasteable block and again
 * in the CI snippet:
 *
 *   gh attestation verify --owner sandstream --repo kit <tarball>
 *
 * which exits 1 on gh 2.96 with `invalid value provided for repo: kit`:
 * `--owner` and `--repo` are ALTERNATIVES, and `--repo` wants `owner/repo`.
 * Nobody noticed because the surrounding prose said the attestation did not
 * exist yet, so the command was never expected to succeed — a broken
 * instruction hiding behind a true caveat. When 6.3.2 made the attestation
 * real, the documented command was still wrong.
 *
 * That is the same disease this repo keeps finding in itself: a check that
 * cannot pass, in a place that reads as if it does. So it gets a gate rather
 * than a fix.
 *
 * Offline and deterministic on purpose — asserting flag GRAMMAR, not network
 * behaviour. A doc test that needed Sigstore would be skipped in CI and
 * therefore worthless.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = ["docs/VERIFY.md", "README.md", ".github/workflows/publish.yml"];

/**
 * Every `gh attestation verify …` invocation in a doc, flattened to one line.
 * Handles both the one-liner and the backslash-continued multi-line form.
 */
function attestationInvocations(text: string): string[] {
  const out: string[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/gh\s+attestation\s+verify\b/.test(lines[i])) continue;
    let cmd = lines[i];
    while (/\\\s*$/.test(cmd) && i + 1 < lines.length) {
      cmd = cmd.replace(/\\\s*$/, " ") + lines[++i];
    }
    // Strip comment markers so a commented example is still checked — a wrong
    // command is wrong whether or not a `#` precedes it.
    out.push(cmd.replace(/^\s*#\s?/, "").trim());
  }
  return out;
}

describe("docs/VERIFY.md documents commands that actually parse", () => {
  const found = DOCS.flatMap((file) =>
    attestationInvocations(readFileSync(join(REPO_ROOT, file), "utf8")).map((cmd) => ({
      file,
      cmd,
    })),
  );

  it("documents `gh attestation verify` somewhere (the gate has something to guard)", () => {
    // Without this, deleting every invocation would make the suite below vacuous
    // and the file would pass while proving nothing.
    assert.ok(
      found.length > 0,
      "no `gh attestation verify` invocation found in any of: " + DOCS.join(", "),
    );
  });

  for (const { file, cmd } of found) {
    it(`${file}: does not pass both --owner and --repo — ${cmd.slice(0, 60)}…`, () => {
      const hasOwner = /--owner\b/.test(cmd);
      const hasRepo = /--repo\b/.test(cmd);
      assert.ok(
        !(hasOwner && hasRepo),
        `\`--owner\` and \`--repo\` are alternatives; passing both exits 1 with ` +
          `"invalid value provided for repo". Use one:\n  ${cmd}`,
      );
    });

    it(`${file}: --repo carries owner/repo — ${cmd.slice(0, 60)}…`, () => {
      const repo = cmd.match(/--repo[= ]+("?)([^\s"]+)\1/);
      if (!repo) return; // --owner form, covered above
      assert.match(
        repo[2],
        /^[^/\s]+\/[^/\s]+$/,
        `--repo wants the full owner/repo (e.g. sandstream/kit), got "${repo[2]}":\n  ${cmd}`,
      );
    });
  }
});
