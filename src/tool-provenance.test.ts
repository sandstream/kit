/**
 * Provenance has to be measured, because the lock used to guess it.
 *
 * `fix.ts` and `commands/setup.ts` both wrote `source: "mise"` for every declared tool, so a
 * lock entry said `mise` for `/opt/homebrew/bin/vercel` — a binary mise does not manage — and
 * `kit check` reported `in sync`, because the only thing it compared was whether an entry with
 * that name existed (#500).
 *
 * The paths below are the real ones from the machine where that was found, which is why the
 * ordering cases exist at all: the kit shim and mise's shims both live under `$HOME`, and
 * Homebrew is reached through `/opt/homebrew/bin` symlinks rather than the Cellar path.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { classifyToolPath, provenanceMismatch } from "./tool-provenance.js";

const HOME = "/Users/dev";
const env = { home: HOME };

describe("classifyToolPath", () => {
  it("classifies the installers measured on a real machine", () => {
    const cases: Array<[string, string]> = [
      ["/opt/homebrew/bin/vercel", "brew"],
      ["/opt/homebrew/bin/gh", "brew"],
      ["/usr/local/Cellar/jq/1.7.1/bin/jq", "brew"],
      ["/home/linuxbrew/.linuxbrew/bin/gh", "brew"],
      [`${HOME}/.local/share/mise/shims/semgrep`, "mise"],
      [`${HOME}/.local/share/mise/installs/node/25.8.0/bin/node`, "mise"],
      [`${HOME}/.kit/shims/bun`, "kit-shim"],
      [`${HOME}/.npm-global/bin/kit`, "npm-global"],
      [`${HOME}/.cargo/bin/rg`, "cargo"],
      [`${HOME}/.asdf/shims/ruby`, "asdf"],
      ["/usr/bin/jq", "system"],
      ["/usr/bin/git", "system"],
      ["/bin/sh", "system"],
      ["/opt/weird/place/tool", "unknown"],
    ];
    for (const [path, expected] of cases) {
      assert.equal(classifyToolPath(path, env).source, expected, path);
    }
  });

  it("marks shims as shims — a shim delegates, so its source is not the origin", () => {
    const kit = classifyToolPath(`${HOME}/.kit/shims/bun`, env);
    assert.equal(kit.shimmed, true);
    assert.match(kit.detail ?? "", /delegates/);

    // mise's shims dir is a shim; an installs path is the real binary.
    assert.equal(classifyToolPath(`${HOME}/.local/share/mise/shims/node`, env).shimmed, true);
    assert.equal(
      classifyToolPath(`${HOME}/.local/share/mise/installs/node/25.8.0/bin/node`, env).shimmed,
      false,
    );
    assert.equal(classifyToolPath("/opt/homebrew/bin/vercel", env).shimmed, false);
  });

  it("prefers the kit shim over the home-dir rules it also matches", () => {
    // Ordering regression: both this and mise live under $HOME.
    assert.equal(classifyToolPath(`${HOME}/.kit-shims/pnpm`, env).source, "kit-shim");
  });

  it("uses an explicit npm prefix when one is known", () => {
    const p = "/opt/custom-npm/bin/kit";
    assert.equal(classifyToolPath(p, env).source, "unknown");
    assert.equal(
      classifyToolPath(p, { ...env, npmPrefix: "/opt/custom-npm" }).source,
      "npm-global",
    );
  });

  it("hedges on ~/.local/bin instead of claiming pipx outright", () => {
    const r = classifyToolPath(`${HOME}/.local/bin/whatever`, env);
    assert.equal(r.source, "pipx");
    assert.match(r.detail ?? "", /not exclusive/);
  });

  it("handles win32 paths case-insensitively", () => {
    const w = { home: "C:\\Users\\dev", platform: "win32" as const };
    assert.equal(classifyToolPath("C:\\Users\\Dev\\.kit\\shims\\bun.exe", w).source, "kit-shim");
    assert.equal(classifyToolPath("C:\\Windows\\System32\\where.exe", w).source, "system");
  });
});

describe("provenanceMismatch", () => {
  const brew = classifyToolPath("/opt/homebrew/bin/vercel", env);

  it("catches the exact defect: lock says mise, binary comes from brew", () => {
    const r = provenanceMismatch("mise", brew);
    assert.equal(r.mismatch, true);
    assert.match(r.reason ?? "", /lock says mise/);
    assert.match(r.reason ?? "", /comes from brew/);
  });

  it("agrees when the lock is right", () => {
    assert.equal(provenanceMismatch("brew", brew).mismatch, false);
  });

  it("says nothing when there is nothing recorded to contradict", () => {
    assert.equal(provenanceMismatch(undefined, brew).mismatch, false);
  });

  it("never contradicts a shim — the shim delegates, so the lock may name the real installer", () => {
    const shim = classifyToolPath(`${HOME}/.kit/shims/bun`, env);
    assert.equal(provenanceMismatch("mise", shim).mismatch, false);
    assert.equal(provenanceMismatch("npm", shim).mismatch, false);
  });

  it("does not alarm on an unclassifiable path — unknown is not evidence of a mismatch", () => {
    const weird = classifyToolPath("/opt/weird/place/tool", env);
    assert.equal(provenanceMismatch("mise", weird).mismatch, false);
  });

  it("treats the lock's 'manual' catch-all as unknown, not as a source", () => {
    assert.equal(provenanceMismatch("manual", classifyToolPath("/opt/x/y", env)).mismatch, false);
    assert.equal(provenanceMismatch("manual", brew).mismatch, true);
  });
});
