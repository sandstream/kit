import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { writeFileSync, readFileSync, rmSync, mkdtempSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  miseShimsDir,
  isDirOnPath,
  activationLine,
  profileNeedsActivation,
  ensureMiseActivation,
} from "./mise-path.js";

describe("mise-path helpers", () => {
  const shims = miseShimsDir("/home/u");

  it("miseShimsDir + activationLine", () => {
    assert.equal(shims, "/home/u/.local/share/mise/shims");
    assert.equal(activationLine(shims), 'export PATH="/home/u/.local/share/mise/shims:$PATH"');
  });

  it("isDirOnPath matches exact entries only", () => {
    assert.equal(isDirOnPath(`/usr/bin:${shims}:/bin`, shims), true);
    assert.equal(isDirOnPath("/usr/bin:/bin", shims), false);
  });

  it("profileNeedsActivation: true when absent, false if shims dir or `mise activate` present", () => {
    assert.equal(profileNeedsActivation("export PATH=/usr/bin", shims), true);
    assert.equal(profileNeedsActivation(`x\n${activationLine(shims)}\n`, shims), false);
    assert.equal(profileNeedsActivation('eval "$(mise activate zsh)"', shims), false);
  });
});

describe("ensureMiseActivation (idempotent file append)", () => {
  it("adds once, then is a no-op", () => {
    const f = join(tmpdir(), `kit-mp-${process.pid}.zshrc`);
    writeFileSync(f, "# my profile\nexport PATH=/usr/bin\n");
    const shims = "/home/u/.local/share/mise/shims";
    try {
      assert.equal(ensureMiseActivation(f, shims), "added");
      assert.ok(readFileSync(f, "utf8").includes(shims));
      assert.equal(ensureMiseActivation(f, shims), "already"); // idempotent
    } finally {
      rmSync(f, { force: true });
    }
  });
});

describe("ensureMiseActivation (append semantics, fail-closed cases)", () => {
  const SHIMS = "/home/u/.local/share/mise/shims";
  // The exact block ensureMiseActivation appends. Pinned here because the leading
  // newline and the `#` comment are what keep the result a *valid* shell profile.
  const BLOCK = (dir: string) =>
    `\n# kit: put mise's shims on PATH so its tools resolve in every shell\nexport PATH="${dir}:$PATH"\n`;

  /** Run `fn` with a fresh temp dir that is always removed. */
  function withTmp(fn: (dir: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), "kit-mise-path-"));
    try {
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("creates the profile from scratch when the file does not exist", () => {
    withTmp((dir) => {
      const f = join(dir, ".bashrc");
      assert.equal(existsSync(f), false);
      assert.equal(ensureMiseActivation(f, SHIMS), "added");
      // A missing profile is treated as empty, not as an error — setup must work on
      // a machine that has no shell profile yet.
      assert.equal(readFileSync(f, "utf8"), BLOCK(SHIMS));
    });
  });

  it("appends after existing content and never rewrites or truncates it", () => {
    withTmp((dir) => {
      const f = join(dir, ".zshrc");
      const before = "# my profile\nexport EDITOR=vim\nsource ~/.aliases\n";
      writeFileSync(f, before);
      assert.equal(ensureMiseActivation(f, SHIMS), "added");
      const after = readFileSync(f, "utf8");
      // Byte-prefix equality: a regression that reordered or rewrote the user's
      // profile would silently destroy their shell config.
      assert.equal(after.slice(0, before.length), before);
      assert.equal(after, before + BLOCK(SHIMS));
    });
  });

  it("does not glue onto the last line of a profile that lacks a trailing newline", () => {
    withTmp((dir) => {
      const f = join(dir, "profile-no-eol");
      writeFileSync(f, "export EDITOR=vim"); // no trailing "\n"
      ensureMiseActivation(f, SHIMS);
      const lines = readFileSync(f, "utf8").split("\n");
      // Without the block's leading newline this would become
      // `export EDITOR=vim# kit: …`, commenting out the export and losing the PATH line.
      // That leading newline is the whole guarantee, so the comment lands on its OWN
      // line and the user's last line survives byte-for-byte.
      assert.equal(lines[0], "export EDITOR=vim");
      assert.ok(lines[1]?.startsWith("# kit:"));
      assert.equal(lines[2], `export PATH="${SHIMS}:$PATH"`);
      // Note the asymmetry, pinned rather than corrected: a profile that DOES end in a
      // newline gains a blank separator line (the block's leading "\n" lands on an
      // already-empty position), one that does not gets no blank line. Cosmetic, and
      // safe either way — what matters is that nothing is ever glued.
    });
  });

  it("leaves the file byte-identical when the profile already runs `mise activate`", () => {
    withTmp((dir) => {
      const f = join(dir, ".bashrc");
      const before = 'eval "$(mise activate bash)"\n';
      writeFileSync(f, before);
      assert.equal(ensureMiseActivation(f, SHIMS), "already");
      // `mise activate` is an accepted alternative: kit must not stack a second,
      // redundant PATH mutation on top of it.
      assert.equal(readFileSync(f, "utf8"), before);
    });
  });

  it("treats a longer path that merely contains the shims dir as already activated", () => {
    withTmp((dir) => {
      const f = join(dir, ".bashrc");
      const before = `export PATH="${SHIMS}-backup:$PATH"\n`;
      writeFileSync(f, before);
      // Detection is a substring match, not an exact PATH-entry match, so a
      // *different* directory sharing this prefix suppresses the append. Documented
      // as-is; see notes — the real shims dir is left off PATH here.
      assert.equal(ensureMiseActivation(f, SHIMS), "already");
      assert.equal(readFileSync(f, "utf8"), before);
    });
  });

  it("counts a commented-out mention of the shims dir as already activated", () => {
    withTmp((dir) => {
      const f = join(dir, ".bashrc");
      const before = `# ${SHIMS} used to be here\n`;
      writeFileSync(f, before);
      // Same substring caveat: an inert comment blocks the append.
      assert.equal(ensureMiseActivation(f, SHIMS), "already");
      assert.equal(readFileSync(f, "utf8"), before);
    });
  });

  it("appends a second block for a different shims dir", () => {
    withTmp((dir) => {
      const f = join(dir, ".bashrc");
      const other = "/opt/other/.local/share/mise/shims";
      assert.equal(ensureMiseActivation(f, SHIMS), "added");
      // Idempotence is keyed to the specific dir, so a home-directory change
      // (e.g. a different user) still gets its own activation line.
      assert.equal(ensureMiseActivation(f, other), "added");
      assert.equal(readFileSync(f, "utf8"), BLOCK(SHIMS) + BLOCK(other));
    });
  });

  it("writes the shims dir verbatim, applying no shell escaping", () => {
    withTmp((dir) => {
      const f = join(dir, ".bashrc");
      const nasty = '/home/we"ird/$(id)/shims';
      assert.equal(ensureMiseActivation(f, nasty), "added");
      // Current behaviour: the path is interpolated straight into a double-quoted
      // shell string with no quoting of `"` or `$(…)`. Recorded so a future change
      // to escaping is a deliberate, visible decision (see notes).
      assert.equal(readFileSync(f, "utf8"), BLOCK(nasty));
      assert.equal(ensureMiseActivation(f, nasty), "already");
    });
  });
});
