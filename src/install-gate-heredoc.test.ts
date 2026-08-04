/**
 * Here-document bodies are data unless a shell eats them — and the install gate must tell the
 * difference.
 *
 * WHY THIS EXISTS. `SEGMENT_SPLIT` includes `\n`, so every line of a here-document was scanned as
 * its own command. Measured: kit's own `gate-bash` blocked the PR description for the plugin
 * write-gate arc, because `gh pr create --body "$(cat <<'EOF' … EOF)"` had the prose
 * "`npx tsc --noEmit` clean" in it, and a backtick in a sentence became a nested command
 * (`BLOCKED — Triage: npm tsc`). The gate blocked a document about the gate.
 *
 * A false block in a security gate is not a harmless annoyance — it is what teaches people to pass
 * `--no-verify`, and this repo already carries one bypassed-hook record in
 * `.kit-skipped-commits.jsonl`.
 *
 * The table below is the contract, and it is two-sided ON PURPOSE: every case that must stop being
 * blocked sits next to the execution path that must keep being blocked, because the cheap fix here
 * ("ignore anything in a here-document") would have opened `bash <<EOF` — the shape an attacker
 * would actually reach for.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseInstallCommand, splitHeredocs } from "./install-gate.js";

/** Does the gate consider this command an install it must triage (i.e. would it block)? */
function gated(command: string): boolean {
  const p = parseInstallCommand(command);
  return p.isInstall && (p.refs.length > 0 || p.unverifiable.length > 0);
}

// Assembled rather than written literally, so this file's own text is not a package-install
// string that kit's `gate-bash` hook would block when an agent greps or edits it.
const EVIL = ["npm", "i", "evil"].join(" ");
const NPX = ["npx", "tsc", "--noEmit"].join(" ");

describe("a here-document body that is DATA is not scanned as commands", () => {
  it("the exact shape that blocked PR #447", () => {
    const command = `gh pr create --title "x" --body "$(cat <<'EOF'\n- build clean; \`${NPX}\` clean\n- 3997/3997 tests\nEOF\n)"`;
    assert.equal(gated(command), false, "prose in a quoted here-document is not an install");
  });

  it("prose written to a markdown file stays prose", () => {
    assert.equal(gated(`cat > PR.md <<'EOF'\nrun ${EVIL} to reproduce\nEOF`), false);
  });

  it("a QUOTED delimiter suppresses expansion, so even a substitution is literal text", () => {
    // `cat <<'EOF'` writes the characters `$(npm i evil)` — the shell never runs them. Blocking
    // this was over-blocking, not caution.
    assert.equal(gated(`cat <<'EOF'\n$(${EVIL})\nEOF`), false);
    assert.equal(gated(`cat <<"EOF"\n$(${EVIL})\nEOF`), false);
    assert.equal(gated(`cat <<\\EOF\n$(${EVIL})\nEOF`), false);
  });

  it("a `<<-` tab-stripped body is data too, and the terminator is still found", () => {
    assert.equal(gated(`cat <<-'EOF'\n\trun ${EVIL} later\n\tEOF`), false);
  });

  it("commands AFTER the here-document are still scanned", () => {
    // The terminator must be located, or everything following it would be absorbed into the body
    // and silently excused. This is the one error direction that could hide a real install.
    assert.equal(gated(`cat <<'EOF'\nprose\nEOF\n${EVIL}`), true);
  });
});

describe("a here-document body that EXECUTES is still gated", () => {
  it("fed straight to a shell", () => {
    assert.equal(gated(`bash <<'EOF'\n${EVIL}\nEOF`), true);
    assert.equal(gated(`sh <<EOF\npip install evil\nEOF`), true);
    assert.equal(gated(`bash -s <<'EOF'\n${EVIL}\nEOF`), true);
    assert.equal(gated(`/bin/bash <<'EOF'\n${EVIL}\nEOF`), true);
  });

  it("piped into a shell", () => {
    assert.equal(gated(`cat <<'EOF' | bash\n${EVIL}\nEOF`), true);
  });

  it("an UNQUOTED delimiter runs its substitutions while the document is built", () => {
    // `cat` only ever sees the OUTPUT, but the shell ran the install to produce it. The consumer
    // being harmless is not the same as the body being harmless.
    assert.equal(gated(`cat <<EOF\n$(${EVIL})\nEOF`), true);
    assert.equal(gated(`cat > notes.md <<EOF\n\`${EVIL}\`\nEOF`), true);
  });

  it("authoring a shell script for later execution", () => {
    // Not executed by this command, but a `*.sh` here-document is written to be run. Narrow by
    // extension so prose files stay data.
    assert.equal(gated(`cat > deploy.sh <<'EOF'\n${EVIL}\nEOF`), true);
    assert.equal(gated(`cat >> /tmp/setup.bash <<'EOF'\n${EVIL}\nEOF`), true);
  });

  it("an UNTERMINATED here-document is scanned, not trusted", () => {
    // The parse is unreliable once the terminator is missing, so the body is kept. Fail-closed.
    assert.equal(gated(`cat <<'EOF'\n${EVIL}`), true);
  });

  it("a here-STRING is untouched by this change", () => {
    assert.deepEqual(parseInstallCommand(`bash <<< "${EVIL}"`).refs, ["npm:evil"]);
  });
});

describe("splitHeredocs is exact about what it removed", () => {
  it("returns the command without the data body, and the body's live substitutions separately", () => {
    const r = splitHeredocs(`cat <<EOF\nprose $(${EVIL}) more\nEOF`);
    assert.equal(r.command.includes("prose"), false, "the body text is gone");
    assert.deepEqual(r.expansions, [EVIL], "the substitution that really runs is kept");
    assert.match(r.command, /EOF/, "the opener and terminator lines remain, so the shape parses");
  });

  it("is a no-op on a command with no here-document", () => {
    const command = `${EVIL} && echo done`;
    assert.deepEqual(splitHeredocs(command), { command, expansions: [] });
  });

  it("handles two here-documents on one line in order", () => {
    const r = splitHeredocs(`diff <<'A' <<'B'\nfirst\nA\nsecond\nB`);
    assert.equal(r.command.includes("first"), false);
    assert.equal(r.command.includes("second"), false);
  });
});
