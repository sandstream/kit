import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyRecommendedHardening } from "./recommended.js";

describe("applyRecommendedHardening", () => {
  let tmp: string;
  const prev = process.env.KIT_CLAUDE_SETTINGS;

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "kit-recommended-"));
  });
  beforeEach(() => {
    process.env.KIT_CLAUDE_SETTINGS = join(
      tmp,
      `claude-${Math.random().toString(36).slice(2)}.json`,
    );
  });
  after(() => {
    if (prev === undefined) delete process.env.KIT_CLAUDE_SETTINGS;
    else process.env.KIT_CLAUDE_SETTINGS = prev;
    rmSync(tmp, { recursive: true, force: true });
  });

  function gitDir(): string {
    return mkdtempSync(join(tmp, "git-")) + "/.git";
  }

  it("wires memory hooks + a pre-commit secret-scan, and a pre-push when context is declared", async () => {
    const g = gitDir();
    const r = await applyRecommendedHardening({ context: { git: { email: "x@y.z" } } }, g);

    // 3 memory hooks (UserPromptSubmit/SessionEnd/SessionStart).
    assert.equal(r.memory.added.length, 3);

    // pre-commit secret-scan gate.
    const pc = readFileSync(join(g, "hooks", "pre-commit"), "utf-8");
    assert.ok(pc.includes("security scan-staged"), "pre-commit runs security scan-staged");

    // pre-push context-check gate (context was declared).
    assert.ok(existsSync(join(g, "hooks", "pre-push")), "pre-push installed when context declared");
    const pp = readFileSync(join(g, "hooks", "pre-push"), "utf-8");
    assert.ok(pp.includes("context check"), "pre-push runs context check");
  });

  it("omits the pre-push context-check gate when no context is declared", async () => {
    const g = gitDir();
    const r = await applyRecommendedHardening({}, g);
    assert.ok(
      r.hooks.some((h) => h.hookName === "pre-commit"),
      "still installs pre-commit",
    );
    assert.equal(existsSync(join(g, "hooks", "pre-push")), false, "no pre-push without context");
  });
});
