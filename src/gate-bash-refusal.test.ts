/**
 * What the operator actually reads when the install-gate blocks.
 *
 * The decision function had tests; the printed refusal did not — and the printed refusal is
 * where the defect lived (#501). A correct block on
 * `git commit -m "… \`deployment:env:view\` …"` was reported as a false positive because the
 * message named a triage target instead of the command substitution it had caught. Backticks
 * inside double quotes ARE substitution:
 *
 *     $ bash -c 'echo "... the permission `deployment:env:view` ..."'
 *     bash: deployment:env:view: command not found
 *     ... the permission  ...
 *
 * so the words silently vanish from the message. The gate prevented that and got distrusted
 * for it. These tests drive the compiled CLI, because a helper that returns the right sentence
 * to nobody is not a fixed message.
 *
 * Both cases are offline by construction — an unresolvable indirection is refused before any
 * registry lookup — so this file never touches the network.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "cli.js");

/**
 * spawnSync, not execFile: the gate reads its payload from STDIN until EOF, and `execFile` has
 * no `input` option — the pipe stays open and the process hangs forever. `input` closes it.
 */
function gateBash(command: string): { exitCode: number; stderr: string } {
  const payload = JSON.stringify({ tool_name: "Bash", tool_input: { command } });
  const r = spawnSync(process.execPath, [CLI_PATH, "gate-bash"], {
    input: payload,
    encoding: "utf-8",
    env: { ...process.env, KIT_HIDE_HOOK_SKIP_BANNER: "1", KIT_AUDIT_ANCHOR: "0" },
    timeout: 60_000,
  });
  return { exitCode: r.status ?? 1, stderr: r.stderr ?? "" };
}

describe("gate-bash refusal wording (compiled CLI)", () => {
  it("names the command substitution and drops the triage advice", () => {
    const r = gateBash("`deployment:env:view` install foo");
    // exit 2 is the PreToolUse deny contract — the block itself must not soften.
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /COMMAND SUBSTITUTION/);
    assert.match(r.stderr, /single quotes are literal/);
    assert.match(r.stderr, /git commit -F/);
    assert.doesNotMatch(
      r.stderr,
      /Triage it first/,
      "triage is nonsense advice for shell quoting, and stapling it there is what made a correct block read as a mis-parse",
    );
  });

  it("keeps the triage advice for an install target it genuinely cannot resolve", () => {
    const r = gateBash("$PM install evil");
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /cannot reduce to a triage target/);
    assert.match(r.stderr, /Triage it first/);
  });

  it("still allows a commit message whose backticks are single-quoted (no substitution)", () => {
    const r = gateBash("git commit -qam 'naming the permission `deployment:env:view` here'");
    assert.equal(r.exitCode, 0, r.stderr);
  });
});
