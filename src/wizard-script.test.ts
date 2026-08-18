import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, accessSync, constants } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `scripts/trusted-publishing-wizard.sh` ↔ the shell it actually runs in.
 *
 * Nothing in this repo lints shell: `format:check` and `lint` cover `.ts` only, and
 * CI has no shellcheck step. So a committed wizard can be broken in ways no gate
 * notices until the human runs it — and this one is run exactly once, during a
 * credential migration, which is the worst moment to discover it.
 *
 * Two failures were found by hand while writing it, both invisible to `node`:
 *
 *   - `mapfile -t PACKAGES < <(…)` — a bash 4 builtin. macOS ships bash 3.2.57 as
 *     /bin/bash, and the machine that publishes kit is a Mac, so the package list
 *     would have come back empty.
 *   - `sed -E 's#…([^/]+?)(\.git)?$#…#'` — POSIX ERE has no lazy quantifier, so
 *     macOS sed exits with "repetition-operator operand invalid".
 *
 * Both are the same class: written against the wrong shell/tool dialect, syntactically
 * fine to the eye. This gate pins the dialect instead of trusting the next author to
 * remember it.
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WIZARD = join(REPO_ROOT, "scripts/trusted-publishing-wizard.sh");
const SOURCE = readFileSync(WIZARD, "utf-8");

/** Lines that actually run — comments are documentation, not dialect. */
const CODE = SOURCE.split("\n").filter((l) => !/^\s*#/.test(l));

describe("trusted-publishing wizard — runs in the shell it will be run in", () => {
  it("parses under bash", () => {
    const r = spawnSync("bash", ["-n", WIZARD], { encoding: "utf-8" });
    assert.equal(r.status, 0, `bash -n failed:\n${r.stderr}`);
  });

  it("parses under macOS's bash 3.2 (/bin/bash), where it will be run", () => {
    const r = spawnSync("/bin/bash", ["-n", WIZARD], { encoding: "utf-8" });
    // Skip loudly rather than pass quietly if this platform has no /bin/bash.
    if (r.error) {
      assert.ok(process.platform !== "darwin", "no /bin/bash on a Mac — that cannot be right");
      return;
    }
    assert.equal(r.status, 0, `/bin/bash -n failed:\n${r.stderr}`);
  });

  it("uses no bash-4-only builtin", () => {
    // `bash -n` accepts these: they parse fine and fail at RUN time on 3.2, which is
    // why the syntax check above is not enough on its own.
    const forbidden = /\b(mapfile|readarray)\b/;
    const offenders = CODE.filter((l) => forbidden.test(l));
    assert.deepEqual(
      offenders,
      [],
      "bash 4 builtin in a script that runs on macOS bash 3.2 — read into an array with a while-read loop instead",
    );
  });

  it("uses no lazy quantifier in sed (POSIX ERE has none)", () => {
    const offenders = CODE.filter((l) => /\bsed\b/.test(l) && /[+*]\?/.test(l));
    assert.deepEqual(offenders, [], "macOS sed rejects `+?`/`*?` — restructure the expression");
  });

  it("is executable", () => {
    accessSync(WIZARD, constants.X_OK);
  });

  it("is discoverable — RELEASING.md points at it", () => {
    // A migration script nobody can find is a script nobody runs.
    const doc = readFileSync(join(REPO_ROOT, "docs/RELEASING.md"), "utf-8");
    assert.match(doc, /scripts\/trusted-publishing-wizard\.sh/);
  });

  it("refuses to remove the npm token before every package is confirmed", () => {
    // The one irreversible-in-effect step: no token AND no trusted publisher means a
    // package's publish step fails. The gate is a `missing` check around the edit.
    assert.match(SOURCE, /missing\+=\("\$pkg"\)/);
    assert.match(SOURCE, /Removing the token now would break/);
  });
});
