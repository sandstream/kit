import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseInstallCommand } from "./install-gate.js";

// Redirections are I/O plumbing, never package operands. The gate previously
// (a) split segments on the `&` INSIDE `2>&1`, shearing the command into a
// garbage "2>" segment, and (b) fed `>/dev/null` to the positional matcher,
// which fail-closed legitimate installs with "cannot reduce: 2>". Found live:
// verifying the 5.18.0 release, `npm i sandstream-kit@5.18.0 --no-audit 2>&1`
// was blocked by the gate of the tool it was installing.
//
// (Separate file from install-gate.test.ts for a reason worth keeping: the
// LIVE gate scans Bash heredocs, so appending these fixtures via a shell
// heredoc was itself blocked — the fixtures look like installs. Written via
// the editor tool instead. The gate gating its own tests is working as
// designed.)
describe("parseInstallCommand — shell redirections are plumbing, not packages", () => {
  const probe = (cmd: string) => parseInstallCommand(cmd);

  it("2>&1 after an install neither splits the segment nor becomes an operand", () => {
    const p = probe("npm i sandstream-kit@5.18.0 --no-audit --no-fund 2>&1 | tail -1");
    assert.deepEqual(p.refs, ["npm:sandstream-kit@5.18.0"]);
    assert.deepEqual(p.unverifiable, []);
  });

  it(">/dev/null 2>&1 in a compound command leaves only the real package", () => {
    const p = probe("npm init -y >/dev/null 2>&1 && npm i left-pad --silent");
    assert.deepEqual(p.refs, ["npm:left-pad"]);
    assert.deepEqual(p.unverifiable, []);
  });

  it("a bare operator consumes its separate file target", () => {
    const p = probe("npm i evil > out.log");
    assert.deepEqual(p.refs, ["npm:evil"]);
    assert.deepEqual(p.unverifiable, []);
  });

  it("&> and 2> with glued targets are dropped", () => {
    const p = probe("pip install requests &>log 2>err.txt");
    assert.deepEqual(p.refs, ["pip:requests"]);
    assert.deepEqual(p.unverifiable, []);
  });

  it("background `&` still separates segments — the install after it is gated", () => {
    const p = probe("true & npm i evil");
    assert.deepEqual(p.refs, ["npm:evil"]);
  });

  it("stderr-to-stdout dup on a pipeline into xargs keeps its fail-close", () => {
    // The redirect must not LOOSEN anything: piping into an install-via-xargs
    // stays unverifiable exactly as before.
    const p = probe("cat list.txt 2>&1 | xargs npm i");
    assert.ok(p.unverifiable.includes("xargs-stdin-install"));
  });

  it("a QUOTED redirect-shaped operand still fail-closes (only bare syntax is plumbing)", () => {
    const p = probe("npm i '>weird'");
    assert.ok(p.unverifiable.length > 0, "quoted '>weird' must stay unverifiable");
  });
});
